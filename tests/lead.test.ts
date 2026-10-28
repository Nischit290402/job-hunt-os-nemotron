/** /lead: parsing, then a lead end to end on the real schema with Telegram stubbed. */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTestDb, pgAvailable } from './pg';
import * as repo from '../src/server/repo';
import { seed } from '../src/server/seed';
import { parseLead, isLinkedInUrl } from '../src/core/lead';
import { appendLeadJd, createLead, isLeadContinuation, leadContactKey } from '../src/server/lead';
import { applyResult } from '../src/server/worker';
import { findContactStep } from '../src/server/steps';
import type { Sql } from '../src/server/sql';

const JD = 'You will build prediction models for autonomous driving behaviours in PyTorch, run experiments at scale. '.repeat(5);

test('parseLead: pipes, labels, optional person and link, LinkedIn links kept but never fetched', () => {
  const a = parseLead(`/lead Motional | Machine Learning Intern | Jane Tan | https://motional.com/careers/1\n${JD}`);
  assert.ok(a.ok && a.lead.company === 'Motional' && a.lead.person === 'Jane Tan' && a.lead.link.endsWith('/1') && a.lead.jd.startsWith('You will'));
  const b = parseLead('/lead Razer | AI Engineer Intern | https://careers.razer.com/x');
  assert.ok(b.ok && b.lead.person === '' && b.lead.link === 'https://careers.razer.com/x');
  const c = parseLead('/lead Grab | ML Intern | -');
  assert.ok(c.ok && c.lead.person === '');
  const d = parseLead(`/lead\nCompany: Shopee\nRole: Data Scientist Intern\nPerson: Wei Ling\nJD: line one\nline two`);
  assert.ok(d.ok && d.lead.company === 'Shopee' && d.lead.person === 'Wei Ling' && d.lead.jd === 'line one\nline two');
  assert.equal(parseLead('/lead Motional').ok, false);
  assert.equal(parseLead('/lead A | B | C | not a url').ok, false);
  assert.ok(isLinkedInUrl('https://www.linkedin.com/posts/jane_abc') && !isLinkedInUrl('https://motional.com/careers'));
});

test('continuation: a reply to the prompt, or the rest of a split paste within 90 s', () => {
  const p = { promptId: 50, jobId: 1, appId: 1, jd: '', lastAt: 1000 };
  assert.equal(isLeadContinuation(p, { reply_to_message: { message_id: 50 } }, 'text', 999_999), true);
  assert.equal(isLeadContinuation(p, {}, 'more text', 30_000), true);
  assert.equal(isLeadContinuation(p, {}, 'a question', 200_000), false);
  assert.equal(isLeadContinuation({ ...p, lastAt: 0, promptId: null }, {}, 'a question', 5000), false);
  assert.equal(isLeadContinuation(p, {}, '/today', 2000), false);
});

const ok = pgAvailable();
let sql: Sql;
let drop = () => {};
const sent: string[] = [];
const TODAY = '2026-10-29';
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable' }, fn);

before(async () => {
  if (!ok) return;
  const d = makeTestDb();
  sql = d.sql;
  drop = d.drop;
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = '1';
  process.env.SIGNING_SECRET = 's'.repeat(32);
  mock.method(globalThis, 'fetch', async (url: string, init?: any) => {
    if (String(url).includes('api.telegram.org')) {
      sent.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }
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

t('lead with a pasted JD: job, Today entry, preferred contact, judging queued; the card follows the judgment', async () => {
  const p = parseLead(`/lead Motional | Machine Learning Intern | Jane Tan | https://www.linkedin.com/posts/jane_abc\n${JD}`);
  assert.ok(p.ok);
  const r = await createLead(sql, p.lead, TODAY);
  assert.equal(r.state, 'today');
  assert.equal(r.queued, true);
  assert.match(r.how, /pasted/);
  const app = await repo.getApplication(sql, r.appId);
  assert.ok(app?.url.startsWith('https://lead.jobhunt.local/'), 'a LinkedIn link is never used as the job URL');
  const contactId = await repo.kvGet<number>(sql, leadContactKey(r.appId));
  assert.equal((await repo.getContact(sql, contactId!))?.name, 'Jane Tan');

  const [task] = await repo.claimTasks(sql, 'cloud', 5);
  assert.equal(task.kind, 'judge');
  assert.equal((task.payload.meta as any).leadAppId, r.appId);
  sent.length = 0;
  await applyResult(sql, task.id, { output: { score: 74, gates: { A1: 'PASS', A2: 'PASS', A3: 'PASS', A4: 'PASS', A5: 'PASS' }, flags: [], notes: 'Good fit.', deadline: '' } });
  assert.ok(sent.some((b) => b.includes('Your lead: ') && b.includes('Motional')), 'lead card sent to Telegram');

  // On Apply, the person you named is the contact.
  await repo.applyEvent(sql, r.appId, 'decide.apply', 'you');
  await repo.applyEvent(sql, r.appId, 'resume.unavailable', 'system');
  const c = await findContactStep(sql, r.appId, TODAY);
  assert.equal(c.contactId, contactId);
  assert.equal((await repo.getApplication(sql, r.appId))?.state, 'awaiting_send');
});

t('lead without a description: asks for it, a later reply supersedes and judges; the same lead twice is not duplicated', async () => {
  const p = parseLead('/lead Cynapse | ML Engineer Intern');
  assert.ok(p.ok);
  const r = await createLead(sql, p.lead, TODAY);
  assert.equal(r.queued, false);
  assert.equal(r.jdChars, 0);
  const a = await appendLeadJd(sql, { promptId: 7, jobId: r.jobId, appId: r.appId, jd: '', lastAt: Date.now() }, JD, TODAY);
  assert.equal(a.judging, true);
  const open = await sql`SELECT count(*)::int n FROM worker_tasks WHERE kind = 'judge' AND ref LIKE ${`job:${r.jobId}:%`} AND status = 'queued'`;
  assert.equal(open[0].n, 1);
  const again = await createLead(sql, p.lead, TODAY);
  assert.equal(again.appId, r.appId);
});
