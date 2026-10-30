/** Outreach expert: code-verified contacts, draft checks, the redraft bound, and no Gmail in demo. No network. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { collect, fakeChat, fakeTavily } from './fakes';
import { makeTestDb, pgAvailable } from './pg';
import { validateCandidate, outreachCheck } from '../src/core/outreachCheck';
import { runOutreach, type OutreachStore } from '../src/agents/outreach';
import { sendDraft } from '../src/server/outreach';
import * as repo from '../src/server/repo';
import { familyOf, type RawJob } from '../src/core/filters';
import type { Card, ChatRequest, ExpertCtx, LlmCall, LlmResult, StreamEvent } from '../src/agents/types';
import type { Sql } from '../src/server/sql';

const TODAY = '2026-10-30';
const COMPANY = 'Acme Robotics';
const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/1';
const SUMMARY = '- MSc AI at NTU, graduating 2027\n- Published a hyperspectral denoising paper\n- Cut model inference latency by 40% at a part-time ML job';
const ENG_URL = 'https://acme.dev/blog/ranking';
const REC_URL = 'https://acme.dev/careers/campus';
const PAGES: Record<string, string> = {
  [ENG_URL]:
    'Acme Robotics engineering blog. Jane Tan, Machine Learning Engineer at Acme Robotics, wrote about how the team trains ranking models on GPUs in Singapore. The post covers data pipelines and evaluation.',
  [REC_URL]: 'Campus hiring at Acme Robotics Singapore. Meet Wei Ling Koh, University Recruiter, who runs our internship programme every year.',
};
const JANE = {
  name: 'Jane Tan',
  headline: 'Machine Learning Engineer',
  kind: 'engineer',
  source_url: ENG_URL,
  evidence_quote: 'Jane Tan, Machine Learning Engineer at Acme Robotics, wrote about how the team trains ranking models',
  hook: 'her post on how the team trains ranking models on GPUs',
};
const GOOD_DRAFT = {
  subject: 'ML Engineer Intern at Acme Robotics',
  email_body: `Hi Jane,\n\nI read your post on training ranking models on GPUs. I am applying for the ML Engineer Intern role (${JOB_URL}). I cut model inference latency by 40% in my part-time ML job and graduate in 2027.\n\nWould you be open to a 15-minute chat or a referral?\n\nNischit`,
  linkedin_note: 'Hi Jane, I read your post on ranking models at Acme Robotics. I am applying for the ML Engineer Intern role and would value a short chat.',
};

const APP = {
  id: 1, job_id: 11, state: 'today', snooze_count: 0, snooze_until: null, picked_on: TODAY, contact_id: null, referral_url: null,
  company: COMPANY, company_id: 5, company_key: 'acmerobotics', title: 'ML Engineer Intern', url: JOB_URL, listing_url: JOB_URL,
  greenhouse_board: 'acme', apply_route: 'official', apply_email: null, family: 'ml', track: 'sg', hours_flag: null,
  jd_text: 'Build ranking models in PyTorch.',
};

function fakeStore(o: { contacts?: any[]; leadContact?: any } = {}) {
  const upserts: any[] = [];
  const drafts: any[] = [];
  const store = {
    getApplication: async (_s: Sql, id: number) => (id === 1 ? APP : null),
    getProfile: async () => ({ body: 'full profile', outreach_summary: SUMMARY, weekly_target: 5 }),
    kvGet: async (_s: Sql, key: string) => (o.leadContact && key === 'lead_contact:1' ? o.leadContact.id : null),
    getContact: async (_s: Sql, id: number) => (o.leadContact?.id === id ? o.leadContact : null),
    contactsAtCompany: async () => o.contacts ?? [],
    upsertContact: async (_s: Sql, c: any) => (upserts.push(c), 100 + upserts.length),
    insertDraft: async (_s: Sql, m: any) => (drafts.push(m), 500 + drafts.length),
  } as unknown as OutreachStore;
  return { store, upserts, drafts };
}

type Reply = Partial<LlmResult>;
function llm(o: { candidates?: unknown[]; draft?: (n: number) => object; review?: object } = {}) {
  let drafts = 0;
  return fakeChat([
    (call: LlmCall): Reply => {
      if (call.tag.step === 'candidates') return { json: { candidates: o.candidates ?? [JANE] } };
      if (call.tag.step === 'review') return { json: o.review ?? { ok: true, problems: [] } };
      drafts++;
      return { json: o.draft ? o.draft(drafts) : GOOD_DRAFT };
    },
  ]);
}

function tavily() {
  return fakeTavily({
    search: (q) =>
      /recruit/i.test(q)
        ? [{ title: 'x', url: 'https://lnkd.in/abc' }, { title: 'Campus', url: REC_URL }]
        : [{ title: 'Jane Tan | LinkedIn', url: 'https://sg.linkedin.com/in/janetan' }, { title: 'Blog', url: ENG_URL }],
    extract: (url) => PAGES[url] ?? '',
  });
}

function makeCtx(l: ExpertCtx['llm'], t: ExpertCtx['tavily'], sql = {} as Sql) {
  const c = collect();
  const ctx: ExpertCtx = { sql, today: TODAY, demo: false, deadlineMs: Date.now() + 600_000, emit: c.emit, llm: l, tavily: t, budgetMode: 'normal' };
  return { ctx, events: c.events };
}

const req = (args: object = { appId: 1 }) => ({ expert: 'outreach' as const, action: 'find_contact_and_draft' as const, args });
const input: ChatRequest = { text: 'draft a referral ask', images: [], history: [] };
const cardOf = (events: StreamEvent[]) => {
  const e = events.find((x) => x.type === 'card') as { type: 'card'; card: Card } | undefined;
  assert.ok(e && e.card.kind === 'draft', 'a draft card is emitted');
  return e.card as Extract<Card, { kind: 'draft' }>;
};
const texts = (events: StreamEvent[]) => events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('\n');

delete process.env.DEMO_MODE;

// ---------- pure checks ----------

test('validateCandidate: the quote, the name and the company must be on a page that was read', () => {
  const pages = Object.entries(PAGES).map(([url, text]) => ({ url, text }));
  const ok = validateCandidate(JANE, pages, COMPANY);
  assert.ok(ok.ok && ok.candidate.name === 'Jane Tan');
  // Whitespace and curly quotes do not matter.
  assert.ok(validateCandidate({ ...JANE, evidence_quote: 'Jane  Tan,\nMachine Learning   Engineer at Acme Robotics' }, pages, COMPANY).ok);

  const fake = validateCandidate({ ...JANE, evidence_quote: 'Jane Tan leads the Acme Robotics perception team and hires interns' }, pages, COMPANY);
  assert.deepEqual(fake, { ok: false, reason: 'evidence quote is not on the page' });
  assert.equal((validateCandidate({ ...JANE, name: 'John Doe' }, pages, COMPANY) as { reason: string }).reason, 'name is not on the page');
  assert.equal((validateCandidate({ ...JANE, source_url: 'https://other.com/x' }, pages, COMPANY) as { reason: string }).reason, 'source_url is not a page that was read');
  assert.equal((validateCandidate({ ...JANE, source_url: 'https://www.linkedin.com/in/jane' }, pages, COMPANY) as { reason: string }).reason, 'LinkedIn is never a source');
  assert.equal((validateCandidate(JANE, pages, 'Globex') as { reason: string }).reason, 'page does not mention the company');
  assert.equal(validateCandidate(null, pages, COMPANY).ok, false);
});

test('outreachCheck: numbers from the summary only, only the job link, 200-char note, no em dash, no flattery', () => {
  const ctx = { summary: SUMMARY, allowedText: `${COMPANY} ML Engineer Intern`, allowedUrls: [JOB_URL] };
  const good = { subject: GOOD_DRAFT.subject, emailBody: GOOD_DRAFT.email_body, linkedinNote: GOOD_DRAFT.linkedin_note };
  assert.ok(outreachCheck(good, ctx).every((c) => c.pass), JSON.stringify(outreachCheck(good, ctx)));

  const bad = {
    subject: 'Quick question',
    emailBody: 'Your amazing work inspired me. I improved accuracy by 99% — see https://github.com/me/repo',
    linkedinNote: `${'x'.repeat(195)} https://a.b`,
  };
  const r = Object.fromEntries(outreachCheck(bad, ctx).map((c) => [c.id, c]));
  assert.equal(r.numbers.pass, false);
  assert.match(r.numbers.detail, /99/);
  assert.equal(r.links.pass, false);
  assert.equal(r.note_length.pass, false);
  assert.equal(r.no_em_dash.pass, false);
  assert.equal(r.no_flattery.pass, false);
});

// ---------- pipeline with fakes ----------

test('pipeline: LinkedIn search results are never extracted; a verified contact is saved from the public page', async () => {
  const l = llm();
  const t = tavily();
  const { ctx, events } = makeCtx(l, t);
  const { store, upserts, drafts } = fakeStore();
  const r = await runOutreach(ctx, req(), input, {}, store);

  assert.equal(t.searched.length, 2);
  assert.ok(t.extracted.length > 0);
  assert.ok(t.extracted.every((u) => !/linkedin\.com|lnkd\.in/i.test(u)), `extracted: ${t.extracted.join(', ')}`);
  assert.deepEqual([...t.extracted].sort(), [ENG_URL, REC_URL].sort());

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].source, 'public_page');
  assert.equal(upserts[0].relation, 'cold');
  assert.equal(upserts[0].linkedinUrl, null);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, 'ask');
  assert.equal(drafts[0].channel, 'linkedin', 'no email address known');

  const card = cardOf(events);
  assert.equal(card.contact?.name, 'Jane Tan');
  assert.equal(card.contact?.sourceUrl, ENG_URL);
  assert.equal(card.messageId, 501);
  assert.equal(card.demo, false);
  assert.ok(card.checks.every((c) => c.pass), JSON.stringify(card.checks));
  assert.equal(l.calls.filter((c) => c.role === 'reason').length, 1);
  const cand = l.calls.find((c) => c.tag.step === 'candidates')!;
  assert.equal(cand.role, 'fast');
  assert.equal(cand.maxTokens, 800);
  assert.match(String(cand.messages[0].content), /untrusted/);
  assert.equal(r.chain?.person, 'Jane Tan');
  assert.deepEqual(r.actions, []);
});

test('pipeline: a candidate whose quote is not on the page is rejected; still a recruiter-track draft with the search link', async () => {
  const l = llm({ candidates: [{ ...JANE, evidence_quote: 'Jane Tan is hiring interns for the Acme Robotics perception team' }] });
  const { ctx, events } = makeCtx(l, tavily());
  const { store, upserts, drafts } = fakeStore();
  await runOutreach(ctx, req(), input, {}, store);

  assert.match(texts(events), /No verifiable public contact found/);
  assert.equal(upserts.length, 0, 'no fake contact is saved');
  assert.equal(drafts.length, 0);
  const card = cardOf(events);
  assert.equal(card.contact, null);
  assert.equal(card.messageId, null);
  assert.ok(card.linkedinSearchUrl.startsWith('https://www.linkedin.com/search/results/people/?keywords='));
  assert.ok(card.subject && card.emailBody);
  const draftCall = l.calls.find((c) => c.role === 'reason')!;
  assert.match(String(draftCall.messages[0].content), /RECRUITER TRACK/);
});

test('pipeline: failed checks and a failed review redraft once; the reason model is called at most twice', async () => {
  const l = llm({
    draft: () => ({ ...GOOD_DRAFT, email_body: `${GOOD_DRAFT.email_body}\nI improved accuracy by 99%.` }),
    review: { ok: false, problems: ['99% is not in the summary'] },
  });
  const { ctx, events } = makeCtx(l, tavily());
  const { store } = fakeStore();
  await runOutreach(ctx, req(), input, {}, store);

  const reason = l.calls.filter((c) => c.role === 'reason');
  assert.equal(reason.length, 2);
  assert.ok(reason.every((c) => c.thinking === false && c.maxTokens === 900));
  assert.match(String(reason[1].messages[1].content), /Fix these problems/);
  assert.equal(l.calls.filter((c) => c.tag.step === 'review').length, 1);
  const checks = Object.fromEntries(cardOf(events).checks.map((c) => [c.id, c]));
  assert.equal(checks.numbers.pass, false, 'real result shown, not hidden');
  assert.equal(checks.review.pass, false);
  assert.equal(checks.redraft.pass, false);
});

test('pipeline: a named person skips the search; no job means a question', async () => {
  const l = llm();
  const t = tavily();
  const { ctx, events } = makeCtx(l, t);
  const { store, upserts } = fakeStore();
  await runOutreach(ctx, req({ appId: 1, person: 'Sam Lee' }), input, {}, store);
  assert.equal(t.searched.length, 0);
  assert.equal(t.extracted.length, 0);
  assert.equal(upserts[0].name, 'Sam Lee');
  assert.equal(cardOf(events).contact?.name, 'Sam Lee');

  const lead = { id: 77, name: 'Wei Ling', headline: 'posted about ML Intern', kind: 'engineer', relation: 'cold', email: 'wl@acme.dev' };
  const b = makeCtx(llm(), tavily());
  const s2 = fakeStore({ leadContact: lead });
  await runOutreach(b.ctx, req({}), { ...input, lastAppId: 1 }, {}, s2.store);
  assert.equal(s2.upserts.length, 0, 'the lead contact is reused');
  assert.equal(s2.drafts[0].contactId, 77);
  assert.equal(s2.drafts[0].channel, 'email', 'the contact has an email and this is not demo mode');

  const c = makeCtx(llm(), tavily());
  await runOutreach(c.ctx, req({}), input, {}, fakeStore().store);
  assert.match(texts(c.events), /Which job/);
  assert.equal(c.events.some((e) => e.type === 'card'), false);
});

test('sendDraft refuses in demo mode before touching the database or Gmail', async () => {
  process.env.DEMO_MODE = '1';
  try {
    const sql = (async () => {
      throw new Error('database must not be touched in demo');
    }) as unknown as Sql;
    const r = await sendDraft(sql, 1, TODAY);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Demo mode/);
  } finally {
    delete process.env.DEMO_MODE;
  }
});

// ---------- real schema ----------

const pg = pgAvailable();
let sql: Sql;
let drop = () => {};
before(() => {
  if (!pg) return;
  const d = makeTestDb();
  sql = d.sql;
  drop = d.drop;
});
after(() => drop());

test('pipeline on the real schema: contact, draft row and card', { skip: pg ? false : 'no Postgres reachable' }, async () => {
  const raw: RawJob = { company: COMPANY, title: 'ML Engineer Intern', location: 'Singapore', url: JOB_URL, posted: TODAY, channel: 'ATS', jdText: 'Build ranking models in PyTorch. '.repeat(20) };
  const { jobId } = await repo.upsertJob(sql, raw, { action: 'keep', track: 'sg', family: familyOf(raw.title), startWindow: '', hoursFlag: '', eligFlag: '' }, null, TODAY);
  const appId = await repo.putInToday(sql, jobId, TODAY);
  await repo.setProfile(sql, 'profile body', SUMMARY);

  const { ctx, events } = makeCtx(llm(), tavily(), sql);
  await runOutreach(ctx, req({ appId }), input, {});
  const card = cardOf(events);
  assert.equal(card.contact?.name, 'Jane Tan');
  const d = await repo.latestDraft(sql, appId);
  assert.equal(d?.id, card.messageId);
  assert.equal(d?.contact_name, 'Jane Tan');
  assert.equal(d?.channel, 'linkedin');
  const c = await sql`SELECT source, relation, linkedin_url FROM contacts WHERE id = ${d?.contact_id}`;
  assert.deepEqual(c[0], { source: 'public_page', relation: 'cold', linkedin_url: null });
});

test('a contact must be a person, never the company or a team', async () => {
  const { looksLikePersonName } = await import('../src/core/outreachCheck');
  assert.equal(looksLikePersonName('Hudson River Trading', 'Hudson River Trading'), false);
  assert.equal(looksLikePersonName('HRT Recruiting Team', 'Hudson River Trading'), false);
  assert.equal(looksLikePersonName('Jane Tan', 'Hudson River Trading'), true);
  assert.equal(looksLikePersonName("Liam O'Brien", 'Grab'), true);
  assert.equal(looksLikePersonName('Grab Holdings', 'Grab'), false);
});
