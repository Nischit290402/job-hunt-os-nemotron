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

test('screenshot leads: caption forms, what was read, and what you typed winning', async () => {
  const { screenshotCaption, leadFromScreenshot } = await import('../src/core/lead');
  assert.deepEqual(screenshotCaption('Jane Tan https://acme.com/jobs/1'), { person: 'Jane Tan', link: 'https://acme.com/jobs/1' });
  assert.deepEqual(screenshotCaption('Acme | ML Intern | - |'), { company: 'Acme', role: 'ML Intern', person: '', link: '' });
  assert.deepEqual(screenshotCaption(''), {});
  const read = { readable: true, company: 'Motional', role: 'ML Intern', person: 'Jane Tan', link: 'motional.com/careers/123', location: 'Singapore', jd: JD };
  const a = leadFromScreenshot(read);
  assert.ok(a && a.company === 'Motional' && a.link === 'https://motional.com/careers/123' && a.jd.startsWith('Location: Singapore\nYou will'));
  const b = leadFromScreenshot(read, 'Wei Ling');
  assert.equal(b?.person, 'Wei Ling', 'your caption wins over the image');
  assert.equal(leadFromScreenshot({ ...read, link: 'see comments' })?.link, '');
  assert.equal(leadFromScreenshot({ readable: false, company: '', role: '' }), null);
  assert.equal(leadFromScreenshot({ readable: true, company: 'Acme', role: '' }), null);
});

t('screenshots: an album is batched atomically, taken once quiet, read by the worker into a lead', async () => {
  const { addShot, takeShots, SHOTS_QUIET_MS, queueScreenshots } = await import('../src/server/lead');
  const now = Date.now();
  const ns = await Promise.all([1, 2, 3].map((i) => addShot(sql, { fileId: `f${i}`, caption: i === 1 ? 'Jane Tan' : '', messageId: 100 + i }, now)));
  assert.deepEqual([...ns].sort(), [1, 2, 3], 'three webhook calls at once, none lost');
  assert.equal(await takeShots(sql, now + 1000), null, 'still within the quiet window');
  const shots = await takeShots(sql, now + SHOTS_QUIET_MS + 1);
  assert.equal(shots?.length, 3);
  assert.equal(await takeShots(sql, now + SHOTS_QUIET_MS + 2), null, 'taken once');

  // Telegram file downloads, stubbed: getFile then the bytes.
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg' } }));
    if (u.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
    if (u.includes('api.telegram.org')) {
      sent.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    }
    return new Response('not found', { status: 404 });
  });
  const q = await queueScreenshots(sql, shots!);
  assert.equal(q.count, 3);
  const [task] = await repo.claimTasks(sql, 'cloud', 1, 'lead');
  assert.equal(task.kind, 'lead');
  assert.equal((task.payload.images as any[]).length, 3);
  assert.match(String(task.payload.input), /Jane Tan/);
  sent.length = 0;
  await applyResult(sql, task.id, { output: { readable: true, company: 'Snap', role: 'Machine Learning Intern', person: '', link: '', location: 'Singapore', jd: JD } });
  assert.ok(sent.some((b) => b.includes('Added') && b.includes('Snap')), 'lead announced');
  const left = await sql`SELECT payload ? 'images' AS has FROM worker_tasks WHERE id = ${task.id}`;
  assert.equal(left[0].has, false, 'screenshots are dropped once read');
  const app = await sql`SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.company = 'Snap'`;
  assert.equal(app.length, 1);
  const contact = await repo.kvGet<number>(sql, leadContactKey(app[0].id));
  assert.equal((await repo.getContact(sql, contact!))?.name, 'Jane Tan', 'the caption names the contact');
});
