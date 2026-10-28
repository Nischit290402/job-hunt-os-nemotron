/** The Claude work queue over the real schema: dedupe, claim order, retries, and a judgment posted by the worker. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTestDb, pgAvailable } from './pg';
import * as repo from '../src/server/repo';
import { seed } from '../src/server/seed';
import { applyResult, applyFailure, queueJudging, ResultError } from '../src/server/worker';
import { resultError, shouldFire, toView } from '../src/core/worker';
import type { Sql } from '../src/server/sql';

const ok = pgAvailable();
let sql: Sql;
let drop = () => {};
const TODAY = '2026-10-29';
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable' }, fn);

before(async () => {
  if (!ok) return;
  const d = makeTestDb();
  sql = d.sql;
  drop = d.drop;
  const sources = JSON.parse(readFileSync(new URL('../seed/sources.json', import.meta.url), 'utf8'));
  const data = JSON.parse(readFileSync(new URL('../seed/seed.json', import.meta.url), 'utf8'));
  await seed(sql, sources, 'Core ML and LLM roles in Singapore.', data);
});
after(() => drop());

test('fire debounce and result checks', () => {
  assert.equal(shouldFire(null, 1000), true);
  assert.equal(shouldFire(1000, 60_000), false);
  assert.equal(shouldFire(1000, 92_000), true);
  assert.equal(shouldFire(1000, 30_000, 20_000), true, 'the last run already reported idle');
  assert.equal(shouldFire(20_000, 30_000, 1000), false, 'idle from an earlier run does not count');
  assert.match(resultError('judge', { score: 80 })!, /output/);
  assert.equal(resultError('judge', { output: { score: 80 } }), null);
  assert.match(resultError('tailor', { tex: 'x', pdfBase64: 'JVBER' })!, /LaTeX/);
  assert.equal(resultError('tailor', { tex: '\\begin{document}x', pdfBase64: 'JVBERi0x', verifyPassed: true }), null);
  assert.match(resultError('coach', { text: ' ' })!, /text/);
});

t('queue: one open task per ref, urgent kinds first, stale claims handed out again', async () => {
  assert.ok(await repo.enqueueTask(sql, 'judge', 'job:1:a', { instructions: 'i', input: 'x', schema: {}, meta: {} }));
  assert.equal(await repo.enqueueTask(sql, 'judge', 'job:1:a', { instructions: 'i', input: 'x' }), null, 'duplicate while open');
  await repo.enqueueTask(sql, 'coach', 'msg:1', { instructions: 'c', input: 'q?' });
  const [first, second] = await repo.claimTasks(sql, 'cloud', 2);
  assert.equal(first.kind, 'coach');
  assert.equal(second.kind, 'judge');
  assert.equal(toView(first).input, 'q?');
  assert.equal((await repo.claimTasks(sql, 'laptop', 5)).length, 0, 'claimed tasks are not handed out twice');
  await sql`UPDATE worker_tasks SET claimed_at = now() - interval '25 minutes' WHERE id = ${second.id}`;
  assert.equal((await repo.claimTasks(sql, 'laptop', 5))[0]?.id, second.id, 'abandoned claim is reclaimed');
  assert.equal((await repo.queueSummary(sql)).open.judge, 1);
});

t('failures: retried until the third attempt, then failed for good', async () => {
  const id = (await repo.enqueueTask(sql, 'judge', 'job:2:b', { instructions: 'i', input: 'x' }))!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const c = (await repo.claimTasks(sql, 'cloud', 10)).find((x) => x.id === id);
    assert.ok(c, `claim ${attempt}`);
    const r = await applyFailure(sql, id, 'model timed out');
    assert.equal(r.status, attempt < 3 ? 'queued' : 'failed');
  }
  assert.equal((await repo.claimTasks(sql, 'cloud', 10)).find((x) => x.id === id), undefined);
});

t('judge: queued with the rubric, a bad answer is refused and can be resent, a good one is saved', async () => {
  await sql`DELETE FROM worker_tasks`;
  const jid = await repo.upsertJob(
    sql,
    { title: 'Machine Learning Engineer Intern', company: 'DRW', location: 'Singapore', url: 'https://job-boards.greenhouse.io/drweng/jobs/9', channel: 'ats', jdText: 'Train ranking models with PyTorch. '.repeat(20) } as any,
    { action: 'keep', track: 'sg', family: 'mle', startWindow: '', hoursFlag: '', eligFlag: '' } as any,
    'gh_drw',
    TODAY
  );
  assert.ok(jid.isNew);
  const q = await queueJudging(sql, TODAY, 10);
  assert.equal(q.queued, 1);
  assert.equal((await queueJudging(sql, TODAY, 10)).queued, 0, 'already queued');
  const [task] = await repo.claimTasks(sql, 'cloud', 5);
  const view = toView(task);
  assert.match(view.instructions, /RUBRIC/);
  assert.match(view.input, /PyTorch/);
  assert.deepEqual((view.schema as any).required, ['score', 'gates', 'flags', 'notes', 'deadline']);

  await assert.rejects(applyResult(sql, task.id, { output: { gates: {} } }), ResultError);
  const good = { output: { score: 84, gates: { A1: 'PASS', A2: 'PASS', A3: 'PASS', A4: 'PASS', A5: 'PASS' }, flags: [], notes: 'Strong match.', deadline: '' } };
  const r = await applyResult(sql, task.id, good);
  assert.equal(r.applied, true);
  const again = await applyResult(sql, task.id, good);
  assert.equal(again.applied, false, 'a duplicate post changes nothing');
  const j = await sql`SELECT score, verdict, model FROM latest_judgments WHERE job_id = ${jid.jobId}`;
  assert.equal(Number(j[0].score), 84);
  assert.equal(j[0].verdict, 'Apply now');
  assert.equal(j[0].model, 'claude-code-worker');
});
