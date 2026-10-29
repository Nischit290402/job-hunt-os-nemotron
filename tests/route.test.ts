/** Apply routes and drafted answers over the real schema. Brave and Telegram are stubbed. */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTestDb, pgAvailable } from './pg';
import * as repo from '../src/server/repo';
import { seed } from '../src/server/seed';
import { resolveRoutes } from '../src/server/route';
import { applyResult, queueAnswers } from '../src/server/worker';
import { pickToday } from '../src/core/ranker';
import type { Sql } from '../src/server/sql';

const ok = pgAvailable();
let sql: Sql;
let drop = () => {};
const TODAY = '2026-10-29';
const sent: string[] = [];
const JD = 'Work on prediction models with PyTorch for autonomous driving behaviours research. '.repeat(6);
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable' }, fn);

before(async () => {
  if (!ok) return;
  const d = makeTestDb();
  sql = d.sql;
  drop = d.drop;
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1', SIGNING_SECRET: 's'.repeat(32), BRAVE_SEARCH_API_KEY: 'k' });
  mock.method(globalThis, 'fetch', async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      sent.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    if (u.includes('api.search.brave.com')) {
      const q = decodeURIComponent(u);
      const results = q.includes('"Motional"')
        ? [
            { url: 'https://builtinsingapore.com/job/x/1', title: 'Machine Learning Internship, Behaviors Research - Motional' },
            { url: 'https://job-boards.greenhouse.io/motional/jobs/123', title: 'Machine Learning Internship, Behaviors Research at Motional' },
          ]
        : [{ url: 'https://glassdoor.sg/x', title: 'Reviews' }];
      return new Response(JSON.stringify({ web: { results } }));
    }
    return new Response('nope', { status: 404 });
  });
  const sources = JSON.parse(readFileSync(new URL('../seed/sources.json', import.meta.url), 'utf8'));
  const data = JSON.parse(readFileSync(new URL('../seed/seed.json', import.meta.url), 'utf8'));
  await seed(sql, sources, 'Core ML roles in Singapore.', data);
});
after(() => {
  mock.restoreAll();
  drop();
});

async function mcfJob(company: string, title: string, jd: string, score: number) {
  const { jobId } = await repo.upsertJob(sql, { company, title, location: 'Singapore', url: `https://www.mycareersfuture.gov.sg/job/${encodeURIComponent(title)}`, posted: TODAY, channel: 'SGP', jdText: jd } as any,
    { action: 'keep', track: 'sg', family: 'ml', startWindow: '', hoursFlag: '', eligFlag: '' }, 'sgp_mcf', TODAY);
  const j = await repo.getJob(sql, jobId);
  await repo.saveJudgment(sql, jobId, (await repo.jobToJudgeById(sql, jobId))!.jd_hash, { score, verdict: 'Apply this week', gates: {} as any, flags: [], notes: '', deadline: '' }, 'm', 'v2');
  return { jobId, j };
}

t('MyCareersFuture jobs: official page found, email kept, the rest hidden from Today', async () => {
  const a = await mcfJob('MOTIONAL SINGAPORE PTE. LIMITED', 'Machine Learning Intern, Behaviors Research', JD, 74);
  const b = await mcfJob('CYNAPSE PTE. LTD.', 'Machine Learning Engineer Intern', `${JD} Interested applicants please send your CV to careers@cynapse.ai.`, 70);
  const c = await mcfJob('NOWHERE PTE. LTD.', 'AI Research Intern', JD, 72);
  const r = await resolveRoutes(sql);
  assert.deepEqual({ official: r.official, email: r.email, none: r.none }, { official: 1, email: 1, none: 1 });
  const ja = await sql`SELECT apply_route, apply_url FROM jobs WHERE id = ${a.jobId}`;
  assert.equal(ja[0].apply_route, 'official');
  assert.equal(ja[0].apply_url, 'https://job-boards.greenhouse.io/motional/jobs/123');
  const jb = await sql`SELECT apply_route, apply_email FROM jobs WHERE id = ${b.jobId}`;
  assert.deepEqual([jb[0].apply_route, jb[0].apply_email], ['email', 'careers@cynapse.ai']);

  const picks = pickToday(await repo.rankCandidates(sql), await repo.employerInfo(sql), { today: TODAY, max: 10 });
  const ids = picks.map((p) => p.jobId);
  assert.ok(ids.includes(a.jobId) && ids.includes(b.jobId));
  assert.ok(!ids.includes(c.jobId), 'no official route and no email: hidden');

  const appId = await repo.putInToday(sql, a.jobId, TODAY);
  assert.equal((await repo.getApplication(sql, appId))?.url, 'https://job-boards.greenhouse.io/motional/jobs/123', 'the agent opens the official page');
  assert.equal((await resolveRoutes(sql)).checked, 0, 'each job is looked up once');
});

t('answers: queued for an application being filled, posted back, sent to Telegram, readable by the agent', async () => {
  const { jobId } = await mcfJob('Grab', 'ML Engineer Intern', JD, 75);
  const appId = await repo.putInToday(sql, jobId, TODAY);
  for (const ev of ['decide.apply', 'resume.unavailable', 'contact.none'] as const) await repo.applyEvent(sql, appId, ev, 'system');
  const app = (await repo.getApplication(sql, appId))!;
  assert.equal(app.state, 'ready_to_fill');
  const id = await queueAnswers(sql, app, [{ qid: 'q1', label: 'Why Grab?', maxLength: 600, required: true }, { qid: 'q2', label: 'Expected salary?', maxLength: null, required: false }]);
  assert.ok(id);
  assert.equal((await repo.latestAnswers(sql, appId))?.status, 'queued');
  const [task] = await repo.claimTasks(sql, 'cloud', 5, 'answers');
  sent.length = 0;
  await applyResult(sql, task.id, { output: { answers: [{ qid: 'q1', text: 'Grab runs ranking at the scale I worked on in OmniRec.' }, { qid: 'q2', text: '' }] } });
  const latest = await repo.latestAnswers(sql, appId);
  assert.equal(latest?.status, 'done');
  assert.equal(latest?.result?.output?.answers?.[0].text, 'Grab runs ranking at the scale I worked on in OmniRec.');
  assert.ok(sent.some((b) => b.includes('Drafted 1 answer') && b.includes('1 left for you')));
});
