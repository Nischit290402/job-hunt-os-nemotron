/**
 * End-to-end over the real schema: seed, collect (with fetch stubbed), build Today, brief data, decisions,
 * the referral path and the caps. Telegram, Gmail and Claude are never called here.
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTestDb, pgAvailable } from './pg';
import * as repo from '../src/server/repo';
import { seed } from '../src/server/seed';
import { collectSource } from '../src/server/collector';
import { buildToday, briefData } from '../src/server/steps';
import type { Sql } from '../src/server/sql';

const ok = pgAvailable();
let sql: Sql;
let drop = () => {};
const TODAY = '2026-10-23';
const NOW = Date.parse('2026-10-23T00:30:00Z');
const JD = 'You will train ranking and retrieval models with PyTorch on large datasets. '.repeat(8);

const GH = {
  jobs: [
    { id: 101, title: 'Quantitative Research Intern', absolute_url: 'https://job-boards.greenhouse.io/drweng/jobs/101', location: { name: 'Singapore' }, first_published: '2026-10-20', content: JD },
    { id: 102, title: 'Senior Quantitative Researcher', absolute_url: 'https://job-boards.greenhouse.io/drweng/jobs/102', location: { name: 'Singapore' }, content: JD },
    { id: 103, title: 'AI Agent Engineer Intern', absolute_url: 'https://job-boards.greenhouse.io/drweng/jobs/103', location: { name: 'Singapore' }, content: JD },
    { id: 104, title: 'Machine Learning Engineer Intern, Summer 2027', absolute_url: 'https://job-boards.greenhouse.io/drweng/jobs/104', location: { name: 'Singapore' }, content: JD },
  ],
};

before(async () => {
  if (!ok) return;
  const t = makeTestDb();
  sql = t.sql;
  drop = t.drop;
  process.env.APP_URL = 'https://app.example';
  const sources = JSON.parse(readFileSync(new URL('../seed/sources.json', import.meta.url), 'utf8'));
  const data = JSON.parse(readFileSync(new URL('../seed/seed.json', import.meta.url), 'utf8'));
  const r = await seed(sql, sources, readFileSync(new URL('../seed/profile.md', import.meta.url), 'utf8'), data);
  assert.equal(r.applied, 2);
  await seed(sql, sources, 'profile', data); // re-running the seed must not duplicate anything
});
after(() => drop());

const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable' }, fn);

t('seed: sources, caps, preferences and past applications (TikTok counts against its cap)', async () => {
  assert.equal((await repo.listSources(sql)).length, 31);
  const prefs = await repo.preferenceBundle(sql);
  assert.deepEqual(prefs.exclude, ['ai agent', 'agentic', 'agent engineer']);
  assert.equal((await repo.employerInfo(sql)).get('bytedance')?.used, 1);
  assert.equal((await repo.appsInStates(sql, ['applied'])).length, 2);
});

t('collect: filters and preference exclusions apply, a 404 source fails without closing jobs', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/boards/drweng/')) return new Response(JSON.stringify(GH), { status: 200 });
    return new Response('nope', { status: 404 });
  });
  try {
    const r = await collectSource(sql, 'gh_drw', TODAY, NOW);
    assert.equal(r.status, 'ok');
    assert.equal(r.listed, 4);
    assert.equal(r.newJobs, 2);
    assert.deepEqual(r.rejected, { senior_title: 1, excluded_role: 1 });
    const dead = await collectSource(sql, 'gh_jump', TODAY, NOW);
    assert.equal(dead.status, 'not_found');
    assert.equal(dead.closed, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

t('Today: one job per employer, judged jobs only, brief data carries scores and health', async () => {
  for (const j of await repo.jobsToJudge(sql, 10)) {
    await repo.saveJudgment(sql, j.id, j.jd_hash, { score: /Quantitative/.test(j.title) ? 81 : 72, verdict: /Quantitative/.test(j.title) ? 'Apply now' : 'Apply this week', gates: {} as any, flags: [], notes: 'fit', deadline: '' }, 'm', 'v2.0');
  }
  const r = await buildToday(sql, TODAY);
  assert.equal(r.added, 1, 'both DRW jobs compete for one DRW slot');
  const d = await briefData(sql, TODAY);
  assert.equal(d.today.length, 1);
  assert.equal(d.today[0].company, 'DRW');
  assert.equal(d.today[0].score, 81);
  assert.equal(d.health.sourcesTotal, 31);
  assert.equal(d.week.target, 5);
  // Running it again the same day changes nothing.
  assert.equal((await buildToday(sql, TODAY)).added, 0);
});

t('decisions: apply, contact found, draft, sent; Today refills next day; stale item auto-snoozes', async () => {
  const [item] = (await briefData(sql, TODAY)).today;
  await repo.applyEvent(sql, item.applicationId, 'decide.apply', 'you');
  await repo.applyEvent(sql, item.applicationId, 'resume.unavailable', 'system');
  const cid = await repo.upsertContact(sql, { companyName: 'DRW', name: 'Jane Tan', headline: 'Quant Researcher', linkedinUrl: 'https://www.linkedin.com/in/janetan', relation: 'cold', kind: 'engineer', source: 'xray', today: TODAY });
  await repo.applyEvent(sql, item.applicationId, 'contact.found', 'system', { contactId: cid });
  await repo.insertDraft(sql, { appId: item.applicationId, contactId: cid, kind: 'ask', subject: 'Referral', body: 'Hi', linkedinNote: 'Hi Jane', channel: 'linkedin' });
  const d = await briefData(sql, TODAY);
  assert.equal(d.approvals.length, 1);
  assert.equal(d.approvals[0].email, null, 'no email: LinkedIn note only');
  assert.equal(d.approvals[0].jobId, item.jobId);

  // The other DRW job is now blocked by the active application (-20) but still eligible; nothing else is judged.
  const next = await buildToday(sql, '2026-10-24');
  assert.equal(next.added, 1);
  const [second] = (await briefData(sql, '2026-10-24')).today;
  assert.notEqual(second.jobId, item.jobId);
  // Left undecided for 3 days: auto-snoozed.
  await buildToday(sql, '2026-10-27');
  const s = await repo.getApplication(sql, second.applicationId);
  assert.equal(s?.state, 'snoozed');
});
