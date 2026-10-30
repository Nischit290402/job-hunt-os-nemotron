/** Job Fetcher expert, the Nemotron judge and the daily run, with fake model and search clients (no network). */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTestDb, pgAvailable } from './pg';
import { collect, fakeChat, fakeTavily } from './fakes';
import { seed } from '../src/server/seed';
import { createLead } from '../src/server/lead';
import { jobFetcher } from '../src/agents/jobFetcher';
import { runDaily } from '../src/server/nemotron/daily';
import type { ChatRequest, ExpertCtx, LlmCall, LlmClient, TavilyClient } from '../src/agents/types';
import type { Sql } from '../src/server/sql';

const TODAY = '2026-10-30';
const JD = 'You will train and evaluate perception models in PyTorch for autonomous driving, run experiments at scale and ship them. '.repeat(5);
const ULTRA = 'nvidia/Nemotron-3-Ultra-test';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-test';

const judgment = (score: number) => ({ score, gates: { A1: 'PASS', A2: 'PASS', A3: 'PASS', A4: 'PASS', A5: 'PASS' }, flags: [], notes: 'Strong ML scope.', deadline: '' });

/** One fake for every role: vision reads the lead, fast triages, reason judges. */
function models(lead: Record<string, unknown> = {}) {
  let n = 0;
  return fakeChat([
    (call: LlmCall) => {
      if (call.role === 'vision' || call.schema?.name === 'lead') return { json: { readable: true, company: '', role: '', person: '', link: '', location: '', jd: '', ...lead }, model: call.role === 'vision' ? 'nvidia/Super-VL-test' : NANO };
      if (call.role === 'reason') return { json: judgment(82), model: ULTRA };
      return { json: judgment(60 + (n++ % 10)), model: NANO };
    },
  ]);
}

function ctxOf(sql: Sql, llm: LlmClient, tavily: TavilyClient, emit: ExpertCtx['emit']): ExpertCtx {
  return { sql, today: TODAY, demo: true, deadlineMs: Date.now() + 60_000, emit, llm, tavily, budgetMode: 'normal' };
}

const input = (text: string, images: ChatRequest['images'] = []): ChatRequest => ({ text, images, history: [] });

test('a LinkedIn link alone is refused: no extract, no search, no model call', async () => {
  const llm = models();
  const tavily = fakeTavily();
  const { emit, events } = collect();
  const r = await jobFetcher.run(ctxOf(null as unknown as Sql, llm, tavily, emit), { expert: 'job_fetcher', action: 'add_lead', args: {} }, input('https://www.linkedin.com/posts/jane_abc-123'), {});
  assert.deepEqual(r, {});
  assert.equal(llm.calls.length, 0);
  assert.equal(tavily.extracted.length + tavily.searched.length, 0);
  assert.ok(events.some((e) => e.type === 'text' && /never open LinkedIn/.test(e.text)));
});

test('describe: what the expert sees and never sees', () => {
  const d = jobFetcher.describe();
  assert.ok(d.sees.some((s) => s.includes('v2.1')) && d.sees.includes('Your last 10 skip reasons'));
  assert.ok(d.neverSees.includes('Your master resume') && d.neverSees.includes('Your contacts'));
});

test('cron route: 401 without the bearer, with a wrong one, and when the secret is empty', async () => {
  const { GET, POST } = await import('../app/api/cron/daily/route');
  delete process.env.CRON_SECRET;
  assert.equal((await GET(new Request('http://x/api/cron/daily', { headers: { authorization: 'Bearer ' } }))).status, 401);
  process.env.CRON_SECRET = 'cron-secret-for-tests';
  assert.equal((await GET(new Request('http://x/api/cron/daily'))).status, 401);
  assert.equal((await POST(new Request('http://x/api/cron/daily', { method: 'POST', headers: { authorization: 'Bearer nope' } }))).status, 401);
  delete process.env.CRON_SECRET;
});

const ok = pgAvailable();
let sql: Sql;
let drop = () => {};
const fetched: string[] = [];
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable' }, fn);

before(async () => {
  if (!ok) return;
  const d = makeTestDb();
  sql = d.sql;
  drop = d.drop;
  mock.method(globalThis, 'fetch', async (url: string) => {
    fetched.push(String(url));
    return new Response('not found', { status: 404 });
  });
  const sources = JSON.parse(readFileSync(new URL('../seed/sources.json', import.meta.url), 'utf8'));
  const data = JSON.parse(readFileSync(new URL('../seed/seed.json', import.meta.url), 'utf8'));
  await seed(sql, sources, 'Core ML and LLM roles in Singapore.', data);
});
after(() => {
  mock.restoreAll();
  drop();
});

t('screenshot -> lead -> Ultra judgment saved with the real model ID; LinkedIn link never extracted', async () => {
  const llm = models({ company: 'Motional', role: 'Machine Learning Intern', person: 'Jane Tan', link: 'https://www.linkedin.com/posts/jane_abc', location: 'Singapore' });
  const posting = 'https://job-boards.greenhouse.io/motional/jobs/4567890';
  const tavily = fakeTavily({
    search: () => [{ title: 'Job Application for Machine Learning Intern at Motional', url: posting, description: 'Singapore' }],
    extract: (u) => (u === posting ? JD : ''),
  });
  const { emit, events } = collect();
  const r = await jobFetcher.run(ctxOf(sql, llm, tavily, emit), { expert: 'job_fetcher', action: 'add_lead', args: {} }, input('', [{ mime: 'image/png', b64: 'iVBORw0KGgo=' }]), {});

  assert.equal(llm.calls[0].role, 'vision');
  assert.equal(llm.calls[0].maxTokens, 1500);
  assert.equal(llm.calls[0].label, 'Nemotron Super VL read the screenshot');
  const reason = llm.calls.filter((c) => c.role === 'reason');
  assert.equal(reason.length, 1);
  assert.equal(reason[0].thinking, true);
  assert.ok(!tavily.extracted.some((u) => /linkedin|lnkd\.in/.test(u)), 'LinkedIn never sent to Extract');
  assert.ok(!fetched.some((u) => /linkedin|lnkd\.in/.test(u)), 'LinkedIn never fetched');
  assert.deepEqual(tavily.extracted, [posting]);

  assert.ok(r.chain?.appId && r.chain.jobId && r.chain.company === 'Motional' && r.chain.person === 'Jane Tan');
  const saved = await sql`SELECT model, score, rubric_version FROM judgments WHERE job_id = ${r.chain!.jobId}`;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, ULTRA);
  assert.equal(saved[0].rubric_version, 'v2.1');
  const card = events.find((e) => e.type === 'card');
  if (!card || card.type !== 'card' || card.card.kind !== 'job') return assert.fail('no job card');
  assert.equal(card.card.model, ULTRA);
  assert.equal(card.card.score, 82);
  assert.equal(card.card.verdict, 'Apply now');
  assert.equal(card.card.url, posting);
  assert.deepEqual(r.actions?.map((a) => [a.request.expert, a.request.action, a.request.args.appId]), [
    ['resume', 'tailor', r.chain!.appId],
    ['outreach', 'find_contact_and_draft', r.chain!.appId],
  ]);
  assert.equal(r.actions?.[1].request.args.person, 'Jane Tan');
  const tasks = await sql`SELECT count(*)::int AS n FROM worker_tasks WHERE ref LIKE ${`job:${r.chain!.jobId}:%`}`;
  assert.equal(tasks[0].n, 0, 'the chat judge never queues the worker');

  // show_top: the lead is listed with its Ultra score.
  const top = collect();
  const s = await jobFetcher.run(ctxOf(sql, models(), fakeTavily(), top.emit), { expert: 'job_fetcher', action: 'show_top', args: {} }, input('what should I apply to today?'), {});
  const jobs = top.events.find((e) => e.type === 'card');
  if (!jobs || jobs.type !== 'card' || jobs.card.kind !== 'jobs') return assert.fail('no jobs card');
  const it = jobs.card.items.find((i) => i.jobId === r.chain!.jobId);
  assert.equal(it?.ultraScore, 82);
  assert.ok(jobs.card.items.every((i) => typeof i.appId === 'number'), 'every row has an application for its buttons');
  assert.ok((s.actions?.length ?? 0) >= 2);
});

t('a lead with no description anywhere: no-JD cap and a text saying so', async () => {
  const llm = models();
  const { emit, events } = collect();
  const r = await jobFetcher.run(ctxOf(sql, llm, fakeTavily(), emit), { expert: 'job_fetcher', action: 'add_lead', args: {} }, input('Hiring ML interns at Shopee SG, DM me. Jane Tan'), {});
  // The fake extraction read nothing: no company or role, so no lead.
  assert.equal(r.chain, undefined);
  assert.ok(events.some((e) => e.type === 'text' && /could not find a job/.test(e.text)));

  const llm2 = models({ company: 'Shopee', role: 'ML Intern', person: 'Jane Tan' });
  const e2 = collect();
  const r2 = await jobFetcher.run(ctxOf(sql, llm2, fakeTavily(), e2.emit), { expert: 'job_fetcher', action: 'add_lead', args: {} }, input('Hiring ML interns at Shopee SG, DM me. Jane Tan'), {});
  assert.ok(r2.chain?.appId);
  assert.ok(e2.events.some((e) => e.type === 'text' && /No job description found/.test(e.text)));
  const card = e2.events.find((e) => e.type === 'card');
  if (!card || card.type !== 'card' || card.card.kind !== 'job') return assert.fail('no job card');
  assert.ok(card.card.score <= 64 && card.card.flags.includes('no JD'));
});

t('createLead with judge none queues no worker task', async () => {
  const r = await createLead(sql, { company: 'Razer', role: 'AI Engineer Intern', person: '', link: '', jd: JD }, TODAY, Date.now(), 'typed', { judge: 'none' });
  assert.equal(r.queued, false);
  assert.equal(r.state, 'today');
  const tasks = await sql`SELECT count(*)::int AS n FROM worker_tasks`;
  assert.equal(tasks[0].n, 0);
});

t('runDaily: Nano triage, then exactly `rejudge` Ultra calls, Today rebuilt, run recorded', async () => {
  for (const c of ['Grab', 'Sea', 'Shopee Labs']) {
    await createLead(sql, { company: c, role: 'Machine Learning Intern', person: '', link: '', jd: JD }, TODAY, Date.now(), 'typed', { judge: 'none' });
  }
  const llm = models();
  const s = await runDaily(sql, TODAY, { sources: 1, triage: 5, rejudge: 2, llm, deadlineMs: Date.now() + 120_000 });
  assert.equal(llm.calls.filter((c) => c.role === 'reason').length, 2);
  assert.ok(llm.calls.filter((c) => c.role === 'fast').length >= 2);
  assert.ok(s.triaged >= 2);
  assert.equal(s.rejudged.length, 2);
  assert.ok(s.rejudged.every((x) => x.model === ULTRA && x.ultra === 82));
  assert.ok(s.today_list);
  const run = await sql`SELECT detail FROM runs WHERE step = 'daily'`;
  assert.equal(run.length, 1);
  assert.ok(!fetched.some((u) => /linkedin|lnkd\.in/.test(u)));
});
