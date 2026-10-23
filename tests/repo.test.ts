/**
 * Repository integration tests against a real Postgres (the same SQL Neon runs).
 * Skipped with a message when no Postgres is reachable; CI starts one as a service.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb, pgAvailable } from './pg';
import * as repo from '../src/server/repo';
import { buildRules, evaluateJob, type RawJob } from '../src/core/filters';
import { DEFAULT_TERMS } from '../src/core/terms';
import { pickToday } from '../src/core/ranker';
import { sha256Hex } from '../src/core/signing';
import type { Sql } from '../src/server/sql';

const ok = pgAvailable();
let sql: Sql;
let drop = () => {};
const TODAY = '2026-10-23';
const R = buildRules(DEFAULT_TERMS);
const JD = 'Responsibilities: build and train ranking models in PyTorch. '.repeat(10);

const keep = (raw: RawJob) => {
  const d = evaluateJob(raw, R, Date.parse(`${TODAY}T00:00:00Z`));
  if (d.action !== 'keep') throw new Error(`fixture rejected: ${JSON.stringify(d)} ${raw.title}`);
  return d;
};
const job = (o: Partial<RawJob>): RawJob => ({
  company: 'AppLovin', title: 'Machine Learning Engineering Intern (2027 Summer Internship)', location: 'Singapore',
  url: 'https://boards.greenhouse.io/applovin/jobs/4713038006?gh_jid=4713038006', posted: '2026-09-20', channel: 'ATS', ...o,
});

before(async () => {
  if (!ok) return;
  const t = makeTestDb();
  sql = t.sql;
  drop = t.drop;
  await repo.upsertSource(sql, { id: 'gh_applovin', type: 'greenhouse', company: 'AppLovin', slug_or_url: 'applovin' });
  await repo.upsertSource(sql, { id: 'agg_freehire', type: 'freehire', company: 'freehire', slug_or_url: 'freehire' });
});
after(() => drop());

const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable (set PGHOST/PGPORT/PGUSER)' }, fn);

t('jobs: aggregator link and board link are one job; ATS link wins; description stored', async () => {
  const agg = job({ url: 'https://boards.greenhouse.io/applovin/jobs/4713038006?gh_jid=4713038006&utm_source=freehire.me', channel: 'AGG' });
  const a = await repo.upsertJob(sql, agg, keep(agg), 'agg_freehire', TODAY);
  assert.equal(a.isNew, true);
  const ats = job({ jdText: JD, atsName: 'greenhouse', atsJobId: '4713038006' });
  const b = await repo.upsertJob(sql, ats, keep(ats), 'gh_applovin', TODAY);
  assert.deepEqual(b, { jobId: a.jobId, isNew: false });
  const j = await repo.getJob(sql, a.jobId);
  assert.equal(j.channel, 'ATS');
  assert.deepEqual(j.also_seen, ['ATS']);
  assert.equal(j.jd_status, 'ok');
  // Same title from a channel with no id, different URL: cross-channel xkey match, no new row.
  const list = job({ url: 'https://example.com/applovin-ml', channel: 'LIST' });
  assert.equal((await repo.upsertJob(sql, list, keep(list), null, TODAY)).jobId, a.jobId);
});

t('jobs: pending description gets fetched later; short text marks it unavailable', async () => {
  const raw = job({ company: 'Razer', title: 'Reinforcement Learning Intern', url: 'https://razer.wd3.myworkdayjobs.com/en-US/careers/job/SG/RL-Intern_JR2026007737', channel: 'AGG' });
  const { jobId } = await repo.upsertJob(sql, raw, keep(raw), 'agg_freehire', TODAY);
  const pending = await repo.jobsNeedingJd(sql, 10);
  assert.ok(pending.some((p) => p.id === jobId));
  await repo.setJd(sql, jobId, 'too short');
  assert.equal((await repo.getJob(sql, jobId)).jd_status, 'unavailable');
});

t('judging queue: new jobs once, again only when the JD changes', async () => {
  const before = await repo.jobsToJudge(sql, 50);
  assert.ok(before.length >= 2);
  assert.equal(before[0].track, 'sg');
  for (const j of before) {
    await repo.saveJudgment(sql, j.id, j.jd_hash, { score: j.company === 'AppLovin' ? 74 : 68, verdict: 'Apply this week', gates: { A1: 'FLAG', A2: 'PASS', A3: 'PASS', A4: 'PASS', A5: 'PASS' }, flags: ['eligibility unverified'], notes: 'n', deadline: '' }, 'test-model', 'v2.0');
  }
  assert.equal((await repo.jobsToJudge(sql, 50)).length, 0);
  const changed = job({ jdText: JD + ' New: LLM ranking.', atsName: 'greenhouse', atsJobId: '4713038006' });
  await repo.upsertJob(sql, changed, keep(changed), 'gh_applovin', TODAY);
  assert.equal((await repo.jobsToJudge(sql, 50)).length, 1);
});

t('ranking from the database: candidates, employer caps, Today picks', async () => {
  const tk = job({ company: 'TikTok', title: 'Machine Learning Engineer Intern - Recommendation - 2027 Start', url: 'https://lifeattiktok.com/search/1', jdText: JD });
  const tk2 = job({ company: 'TikTok Pte. Ltd.', title: 'Large Recommendation Model Algorithm Engineer Intern - 2027 Start', url: 'https://lifeattiktok.com/search/2', jdText: JD });
  const a = await repo.upsertJob(sql, tk, keep(tk), null, TODAY);
  const b = await repo.upsertJob(sql, tk2, keep(tk2), null, TODAY);
  for (const id of [a.jobId, b.jobId]) {
    await repo.saveJudgment(sql, id, null, { score: id === a.jobId ? 80 : 79, verdict: 'Apply now', gates: {} as any, flags: [], notes: '', deadline: 'rolling' }, 'm', 'v2.0');
  }
  await repo.setEmployerCap(sql, 'TikTok', 2);
  const emp = await repo.employerInfo(sql);
  assert.deepEqual(emp.get('bytedance'), { active: 0, used: 0, cap: 2 });
  const picked = pickToday(await repo.rankCandidates(sql), emp, { today: TODAY });
  assert.equal(picked.filter((p) => p.companyKey === 'bytedance').length, 1, 'one TikTok job per day');
  assert.equal(picked[0].jobId, a.jobId);
});

t('applications: Today, apply flow, optimistic state check, snooze twice = skip', async () => {
  const cands = await repo.rankCandidates(sql);
  const tk = cands.find((c) => c.companyKey === 'bytedance' && c.score === 80)!;
  const appId = await repo.putInToday(sql, tk.jobId, TODAY);
  assert.equal(await repo.applyEvent(sql, appId, 'decide.apply', 'you'), 'tailoring');
  await assert.rejects(repo.applyEvent(sql, appId, 'decide.apply', 'you'), /not allowed/);
  assert.equal(await repo.applyEvent(sql, appId, 'resume.unavailable', 'system'), 'finding_contact');
  assert.equal((await repo.employerInfo(sql)).get('bytedance')!.used, 1);

  const other = cands.find((c) => c.companyKey === 'bytedance' && c.score === 79)!;
  const a2 = await repo.putInToday(sql, other.jobId, TODAY);
  assert.equal(await repo.applyEvent(sql, a2, 'decide.snooze', 'you', { snoozeUntil: '2026-10-26' }), 'snoozed');
  assert.deepEqual(await repo.dueSnoozedIds(sql, '2026-10-25'), []);
  assert.deepEqual(await repo.dueSnoozedIds(sql, '2026-10-26'), [a2]);
  assert.equal(await repo.putInToday(sql, other.jobId, '2026-10-26'), a2);
  assert.equal(await repo.applyEvent(sql, a2, 'decide.snooze', 'you', { snoozeUntil: '2026-10-29' }), 'skipped');
  const [row] = await repo.appsInStates(sql, ['skipped']);
  assert.equal(row.skip_reason, 'snoozed twice');
  assert.deepEqual(await repo.staleTodayIds(sql, TODAY), []);
});

t('contacts, drafts, send counters and do-not-contact', async () => {
  const cid = await repo.upsertContact(sql, { companyName: 'TikTok', name: 'Keyi Xiang', headline: 'Machine Learning Engineer', linkedinUrl: 'https://www.linkedin.com/in/keyi', relation: 'connection', kind: 'engineer', source: 'connections', today: TODAY });
  const again = await repo.upsertContact(sql, { companyName: 'TikTok', name: 'Keyi Xiang', headline: 'MLE, Search', linkedinUrl: 'https://www.linkedin.com/in/keyi', email: 'keyi@tiktok.com', emailSource: 'hunter', emailConfidence: 'verified', relation: 'cold', kind: 'engineer', source: 'xray', today: TODAY });
  assert.equal(again, cid);
  const c = await repo.getContact(sql, cid);
  assert.equal(c.relation, 'connection', 'a known connection never downgrades to cold');
  assert.equal(c.email, 'keyi@tiktok.com');
  assert.deepEqual(await repo.connectionNamesByCompany(sql, 'bytedance'), ['Keyi Xiang (MLE, Search)']);

  const [app] = await repo.appsInStates(sql, ['finding_contact']);
  const mid = await repo.insertDraft(sql, { appId: app.id, contactId: cid, kind: 'ask', subject: 'S', body: 'B', linkedinNote: 'N', channel: 'email' });
  await repo.updateDraftBody(sql, mid, 'B2');
  assert.equal((await repo.latestDraft(sql, app.id)).body, 'B2');
  assert.equal(await repo.markMessageSent(sql, mid, 'email', { id: 'm1', threadId: 't1' }), true);
  assert.equal(await repo.markMessageSent(sql, mid, 'email', { id: 'm1', threadId: 't1' }), false, 'a draft is sent once');
  const counts = await repo.sendCounts(sql, (await sql`SELECT (now() AT TIME ZONE 'Asia/Singapore')::date::text AS d`)[0].d);
  assert.deepEqual(counts, { today: 1, week: 1 });
  assert.equal((await repo.sentEmailsAwaitingReply(sql)).length, 1);
  await repo.setDoNotContact(sql, 'KEYI@tiktok.com');
  assert.ok((await repo.doNotContactSet(sql)).has('keyi@tiktok.com'));
});

t('resume PDF round-trips through bytea', async () => {
  const [app] = await repo.appsInStates(sql, ['finding_contact']);
  const pdf = Buffer.from('%PDF-1.4 fake\n%%EOF').toString('base64');
  await repo.saveResume(sql, app.id, { tex: '\\documentclass{article}', pdfBase64: pdf, summary: 'swapped bullet', verifyPassed: true, verifyOutput: 'ok' });
  const r = await repo.latestResume(sql, app.id);
  assert.equal(r.pdf_base64.replace(/\s/g, ''), pdf);
});

t('preferences, profile, kv pause', async () => {
  await repo.setProfile(sql, 'Profile body', 'Summary', 5);
  const id = await repo.addPreference(sql, 'exclude_term', 'agent');
  await repo.addPreference(sql, 'rule', 'Core ML or LLM engineering only');
  await repo.addPreference(sql, 'skip_feedback', 'TikTok AI Agent Intern: wrong scope', 'skip');
  const b = await repo.preferenceBundle(sql);
  assert.deepEqual(b, { rules: ['Core ML or LLM engineering only'], exclude: ['agent'], archive: [], skips: ['TikTok AI Agent Intern: wrong scope'] });
  assert.equal(await repo.deactivatePreference(sql, id), true);
  assert.deepEqual((await repo.preferenceBundle(sql)).exclude, []);
  assert.equal(await repo.isPaused(sql), false);
  await repo.kvSet(sql, 'paused', true);
  assert.equal(await repo.isPaused(sql), true);
});

t('runs, health, credits, weekly stats, reject sample', async () => {
  const today = (await sql`SELECT (now() AT TIME ZONE 'Asia/Singapore')::date::text AS d`)[0].d as string;
  await repo.recordSourceResult(sql, 'gh_applovin', 'ok', 12, true);
  await repo.recordRun(sql, { step: 'collect', sourceId: 'gh_applovin', seconds: 1.2, ok: true, detail: { rejected_sample: [{ title: 'Senior ML Eng', reason: 'senior_title' }] } });
  await repo.recordRun(sql, { step: 'collect', sourceId: 'cr_optiver', seconds: 3, ok: true, credits: 1 });
  await repo.recordRun(sql, { step: 'judge', seconds: 20, ok: true, detail: { judged: 4 }, tokensIn: 24000, tokensOut: 1200 });
  await repo.recordRun(sql, { step: 'collect', sourceId: 'agg_freehire', seconds: 2, ok: false, error: 'HTTP 503' });
  const h = await repo.healthSummary(sql, today);
  assert.deepEqual(h && { ok: h.sourcesOk, total: h.sourcesTotal, failed: h.failedSteps, judged: h.judgedToday, fc: h.firecrawlToday }, { ok: 1, total: 2, failed: 1, judged: 4, fc: 1 });
  assert.deepEqual(await repo.firecrawlCredits(sql, today), { today: 1, month: 1, total: 1 });
  assert.equal((await repo.tokensThisMonth(sql, today)).in, 24000);
  const w = await repo.weekStats(sql, today);
  assert.equal(w.target, 5);
  assert.equal((await repo.rejectSample(sql, today)).length, 1);
  const f = await repo.weeklyFunnel(sql, today);
  assert.ok(Number(f.asks) >= 1);
});

t('closing: a job missing twice from an OK source closes', async () => {
  const raw = job({ company: 'Acme AI', title: 'AI Research Intern', url: 'https://boards.greenhouse.io/acme/jobs/555', atsName: 'greenhouse', atsJobId: '555' });
  const { jobId } = await repo.upsertJob(sql, raw, keep(raw), 'gh_applovin', '2026-10-20');
  assert.equal(await repo.markMissing(sql, 'gh_applovin', '2026-10-21'), 0);
  assert.equal(await repo.markMissing(sql, 'gh_applovin', '2026-10-22'), 1);
  assert.equal((await repo.getJob(sql, jobId)).closed_at, '2026-10-22');
});

t('review fixes: atomic counters, one send per draft, update dedupe, only the newest login code works', async () => {
  const n = await Promise.all([1, 2, 3, 4, 5].map(() => repo.kvIncrement(sql, 'ctr')));
  assert.deepEqual([...n].sort(), [1, 2, 3, 4, 5]);
  await repo.kvSet(sql, 'ctr', 0);
  assert.equal(await repo.kvIncrement(sql, 'ctr'), 1);

  assert.equal(await repo.claimTelegramUpdate(sql, 100), true);
  assert.equal(await repo.claimTelegramUpdate(sql, 100), false);
  assert.equal(await repo.claimTelegramUpdate(sql, 101), true);

  const [app] = await repo.appsInStates(sql, ['finding_contact']);
  const c = await repo.upsertContact(sql, { companyName: 'TikTok', name: 'A B', relation: 'cold', kind: 'engineer', source: 'manual', today: TODAY });
  const mid = await repo.insertDraft(sql, { appId: app.id, contactId: c, kind: 'followup', subject: 'Re: S', body: 'b', linkedinNote: '', channel: 'email', threadId: 't9', inReplyTo: '<m1@mail>' });
  assert.equal((await repo.latestDraft(sql, app.id)).in_reply_to, '<m1@mail>');
  const claims = await Promise.all([repo.claimDraftForSend(sql, mid), repo.claimDraftForSend(sql, mid)]);
  assert.deepEqual(claims.sort(), [false, true]);
  await repo.releaseDraft(sql, mid);
  assert.equal(await repo.claimDraftForSend(sql, mid), true, 'a failed send can be retried');
  await repo.finalizeSent(sql, mid, 'email', { id: 'g1', threadId: 't9' });
  await repo.releaseDraft(sql, mid);
  assert.equal(await repo.claimDraftForSend(sql, mid), false, 'a delivered email is never released');

  await repo.storeLoginCode(sql, 'old', 600);
  await repo.storeLoginCode(sql, 'new', 600);
  assert.equal(await repo.consumeLoginCode(sql, 'old'), false);
  assert.equal(await repo.consumeLoginCode(sql, 'new'), true);
});

t('login codes are single use', async () => {
  const h = await sha256Hex('123456');
  await repo.storeLoginCode(sql, h, 600);
  assert.equal(await repo.consumeLoginCode(sql, h), true);
  assert.equal(await repo.consumeLoginCode(sql, h), false);
});
