/** Orchestrator and router scenarios from plan v2 section 5. Real intake rules; no network: fake LLM, fake Tavily, fake experts, fake sql. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChat, fakeTavily, collect } from './fakes';
import { runTurn, parseChatRequest, sortIntents, STOPPED_TEXT, SAVER_TEXT } from '../src/agents/orchestrator';
import { parseRouterOut, actionLabel, ROUTER_LABEL } from '../src/agents/router';
import { LlmCapError } from '../src/server/nebius';
import type { ActionRequest, ChainContext, ChatRequest, Expert, ExpertId, ExpertResult, StreamEvent } from '../src/agents/types';
import type { Sql } from '../src/server/sql';

// ---- fakes local to this test ----

interface Call {
  id: ExpertId;
  req: ActionRequest;
  input: ChatRequest;
  chain: ChainContext;
}
function fakeExperts(results: Partial<Record<ExpertId, ExpertResult | (() => Promise<ExpertResult>)>> = {}) {
  const calls: Call[] = [];
  const mk = (id: ExpertId): Expert => ({
    id,
    describe: () => ({ purpose: id, sees: [], neverSees: [], models: [], tools: [] }),
    run: async (_ctx, req, input, chain) => {
      calls.push({ id, req, input, chain });
      const r = results[id];
      return typeof r === 'function' ? r() : r ?? {};
    },
  });
  return { calls, experts: { job_fetcher: mk('job_fetcher'), resume: mk('resume'), outreach: mk('outreach') } };
}

function fakeSql(apps: Record<number, { company: string; title: string; jd_text?: string }> = {}) {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    queries.push(q);
    if (/FROM applications a JOIN jobs j/.test(q) && /WHERE a\.id =/.test(q)) {
      const id = Number(values[0]);
      const a = apps[id];
      return a ? [{ id, job_id: id * 10, state: 'today', company: a.company, company_id: 1, company_key: a.company.toLowerCase(), title: a.title, url: 'https://x.test/j', listing_url: 'https://x.test/j', jd_text: a.jd_text ?? '' }] : [];
    }
    if (/FROM applications a JOIN jobs j/.test(q) && /lower\(j\.company\)/.test(q)) {
      const name = String(values[1]).toLowerCase();
      const hit = Object.entries(apps).reverse().find(([, a]) => a.company.toLowerCase().startsWith(name));
      return hit ? [{ id: Number(hit[0]), company: hit[1].company }] : [];
    }
    return [];
  }) as unknown as Sql & { queries: string[] };
  sql.queries = queries;
  return sql;
}

const req = (o: Partial<ChatRequest>): ChatRequest => ({ text: '', images: [], history: [], ...o });
const IMG = { mime: 'image/png', b64: 'iVBORw0KGgo=' };
const normal = async () => 'normal' as const;
const routerJson = (intents: unknown[], clarify = '', reply = '') => ({ json: { intents, clarify, reply }, costUsd: 0.0001 });
const intent = (action: string, confidence: number, args: Record<string, string> = {}) => ({
  expert: action === 'tailor' ? 'resume' : action === 'find_contact_and_draft' ? 'outreach' : 'job_fetcher',
  action,
  confidence,
  args: { company: '', appRef: '', person: '', note: '', url: '', ...args },
});

const of = <T extends StreamEvent['type']>(events: StreamEvent[], type: T) => events.filter((e) => e.type === type) as Extract<StreamEvent, { type: T }>[];

async function turn(r: ChatRequest, o: { llm?: ReturnType<typeof fakeChat>; results?: Parameters<typeof fakeExperts>[0]; apps?: Parameters<typeof fakeSql>[0]; mode?: 'normal' | 'saver' | 'stopped' } = {}) {
  const llm = o.llm ?? fakeChat([{ content: '{}' }]);
  const tavily = fakeTavily();
  const ex = fakeExperts(o.results);
  const sql = fakeSql(o.apps);
  const { emit, events } = collect();
  await runTurn(sql, r, emit, { llm, tavily, experts: ex.experts, budget: o.mode ?? 'normal', now: () => Date.UTC(2026, 9, 30, 2) });
  return { llm, tavily, calls: ex.calls, sql, events };
}

// ---- scenarios ----

test('1: screenshot alone -> Job Fetcher add_lead, no router call, tailor and outreach offered for the new app', async () => {
  const t = await turn(req({ images: [IMG] }), { results: { job_fetcher: { chain: { appId: 42, jobId: 420, company: 'Acme' } } } });
  assert.equal(t.llm.calls.length, 0);
  assert.deepEqual(t.calls.map((c) => [c.id, c.req.action]), [['job_fetcher', 'add_lead']]);
  assert.equal(t.calls[0].input.images.length, 1);
  const acts = of(t.events, 'actions');
  assert.equal(acts.length, 1);
  assert.deepEqual(acts[0].actions.map((a) => [a.request.action, a.request.args.appId]), [['tailor', 42], ['find_contact_and_draft', 42]]);
  assert.equal(acts[0].actions[0].label, 'Tailor for Acme');
  const done = t.events.at(-1)!;
  assert.equal(done.type, 'done');
  assert.deepEqual(done.type === 'done' && done.chain, { appId: 42, jobId: 420, company: 'Acme' });
});

test('2: screenshot + "tailor and find someone" -> add_lead runs, tailor and outreach become prefilled buttons', async () => {
  const llm = fakeChat([routerJson([intent('tailor', 0.9, { appRef: 'last' }), intent('find_contact_and_draft', 0.85, { appRef: 'last', note: 'an engineer' })])]);
  const t = await turn(req({ images: [IMG], text: 'tailor my resume and find someone' }), { llm, results: { job_fetcher: { chain: { appId: 42, company: 'Acme' }, actions: [{ label: 'Tailor resume', request: { expert: 'resume', action: 'tailor', args: { appId: 42 } } }] } } });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].label, ROUTER_LABEL);
  assert.deepEqual(t.calls.map((c) => c.id), ['job_fetcher'], 'only intent 1 runs');
  const acts = of(t.events, 'actions');
  assert.equal(acts.length, 1, 'one actions event');
  const a = acts[0].actions;
  assert.deepEqual(a.map((x) => x.request.action), ['tailor', 'find_contact_and_draft'], 'deduplicated by expert+action');
  assert.ok(a.every((x) => x.request.args.appId === 42));
  assert.equal(a[1].request.args.note, 'an engineer');
  assert.deepEqual(a.map((x) => x.label), ['Tailor for Acme', 'Find someone at Acme']);
  assert.equal(t.events.at(-1)!.type, 'done');
});

test('4: LinkedIn URL -> no expert, no LLM call, no Tavily call, upload button', async () => {
  const t = await turn(req({ text: 'https://www.linkedin.com/posts/jane-tan_hiring-activity-123' }));
  assert.equal(t.llm.calls.length, 0);
  assert.equal(t.calls.length, 0);
  assert.equal(t.tavily.searched.length + t.tavily.extracted.length, 0);
  assert.equal(of(t.events, 'text').length, 1);
  assert.match(of(t.events, 'text')[0].text, /linkedin/i);
  assert.deepEqual(of(t.events, 'actions')[0].actions.map((a) => a.label), ['Upload a screenshot']);
  assert.equal(t.events.at(-1)!.type, 'done');
});

test('9: "draft a referral ask for this" with a verified lastAppId -> Outreach on that app', async () => {
  const llm = fakeChat([routerJson([intent('find_contact_and_draft', 0.92, { appRef: 'last' })])]);
  const t = await turn(req({ text: 'draft a referral ask for this', lastAppId: 7 }), { llm, apps: { 7: { company: 'Acme', title: 'ML Intern' } } });
  assert.deepEqual(t.calls.map((c) => [c.id, c.req.action, c.req.args.appId]), [['outreach', 'find_contact_and_draft', 7]]);
  assert.equal(t.calls[0].chain.appId, 7);
  assert.equal(t.calls[0].input.lastAppId, 7);
});

test('9b: an unverified lastAppId is dropped and the user is asked which job', async () => {
  const llm = fakeChat([routerJson([intent('find_contact_and_draft', 0.92, { appRef: 'last' })])]);
  const t = await turn(req({ text: 'draft a referral ask for this', lastAppId: 999 }), { llm });
  assert.equal(t.calls.length, 0);
  assert.match(of(t.events, 'text')[0].text, /Which job/);
  assert.ok(of(t.events, 'actions')[0].actions.some((a) => a.label === 'Upload a screenshot'));
});

test('10: "Grab" -> two intents near 0.5 -> clarify with one button each, nothing runs', async () => {
  const llm = fakeChat([routerJson([intent('search_company', 0.5, { company: 'Grab' }), intent('tailor', 0.48, { appRef: 'Grab', company: 'Grab' })], "Search Grab's roles, or work on your Grab application?")]);
  const t = await turn(req({ text: 'Grab' }), { llm });
  assert.equal(t.calls.length, 0);
  assert.equal(of(t.events, 'text')[0].text, "Search Grab's roles, or work on your Grab application?");
  const a = of(t.events, 'actions')[0].actions;
  assert.deepEqual(a.map((x) => x.label), ['Search Grab', 'Tailor for Grab']);
  assert.equal(of(t.events, 'route').length, 1);
});

test('low confidence -> reply text plus capability buttons', async () => {
  const llm = fakeChat([routerJson([], '', 'I help with job leads, resumes and referral asks.')]);
  const t = await turn(req({ text: 'hi, what can you do?' }), { llm });
  assert.equal(t.calls.length, 0);
  assert.equal(of(t.events, 'text')[0].text, 'I help with job leads, resumes and referral asks.');
  const labels = of(t.events, 'actions')[0].actions.map((a) => a.label);
  assert.deepEqual(labels.slice(0, 2), ['Try a job screenshot', 'What should I apply to today?']);
});

test('high confidence: appRef by company name resolves to the newest app there; only intent 1 runs', async () => {
  const llm = fakeChat([routerJson([intent('tailor', 0.9, { appRef: 'Grab', note: 'lead with ranking' }), intent('find_contact_and_draft', 0.7, { appRef: 'Grab' })])]);
  const t = await turn(req({ text: 'tailor my resume for the Grab one, lead with ranking, then find someone' }), {
    llm,
    apps: { 3: { company: 'Grab', title: 'MLE Intern' } },
    results: { resume: { chain: { appId: 3, company: 'Grab' } } },
  });
  assert.deepEqual(t.calls.map((c) => [c.id, c.req.args.appId, c.req.args.note]), [['resume', 3, 'lead with ranking']]);
  const a = of(t.events, 'actions')[0].actions;
  assert.deepEqual(a.map((x) => [x.request.action, x.request.args.appId, x.label]), [['find_contact_and_draft', 3, 'Find someone at Grab']]);
});

test('high confidence with appRef last: tailor runs with the note, outreach becomes a button for the same app', async () => {
  const llm = fakeChat([routerJson([intent('tailor', 0.9, { appRef: 'last', note: 'lead with ranking' }), intent('find_contact_and_draft', 0.7, { appRef: 'last' })])]);
  const t = await turn(req({ text: 'tailor my resume for this, lead with ranking', lastAppId: 3 }), {
    llm,
    apps: { 3: { company: 'Grab', title: 'MLE Intern' } },
    results: { resume: { chain: { appId: 3, company: 'Grab' } } },
  });
  assert.deepEqual(t.calls.map((c) => [c.id, c.req.args.appId, c.req.args.note]), [['resume', 3, 'lead with ranking']]);
  const a = of(t.events, 'actions')[0].actions;
  assert.deepEqual(a.map((x) => [x.request.action, x.request.args.appId]), [['find_contact_and_draft', 3]]);
});

test('R2 job link -> add_lead with the url, no router call for a bare link', async () => {
  const t = await turn(req({ text: 'https://boards.greenhouse.io/acme/jobs/123' }), { results: { job_fetcher: { chain: { appId: 5 } } } });
  assert.equal(t.llm.calls.length, 0);
  assert.deepEqual(t.calls.map((c) => [c.req.action, c.req.args.url]), [['add_lead', 'https://boards.greenhouse.io/acme/jobs/123']]);
});

test('tapped action skips intake and router', async () => {
  const t = await turn(req({ action: { expert: 'job_fetcher', action: 'show_top', args: {} } }));
  assert.equal(t.llm.calls.length, 0);
  assert.deepEqual(t.calls.map((c) => c.req.action), ['show_top']);
});

test('budget stopped -> banner and done, zero LLM calls, no expert', async () => {
  const t = await turn(req({ images: [IMG], text: 'tailor my resume and find someone' }), { mode: 'stopped' });
  assert.equal(t.llm.calls.length, 0);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.events.map((e) => e.type), ['banner', 'done']);
  assert.equal(of(t.events, 'banner')[0].text, STOPPED_TEXT);
});

test('budget saver -> one info banner, then the turn runs', async () => {
  const t = await turn(req({ images: [IMG] }), { mode: 'saver' });
  const b = of(t.events, 'banner');
  assert.equal(b.length, 1);
  assert.equal(b[0].text, SAVER_TEXT);
  assert.equal(t.calls.length, 1);
});

test('a cap hit mid-turn becomes the stopped banner, other errors a short error event; done is always last', async () => {
  const capped = await turn(req({ images: [IMG] }), { results: { job_fetcher: async () => { throw new LlmCapError('cap'); } } });
  assert.equal(of(capped.events, 'banner')[0].text, STOPPED_TEXT);
  assert.equal(of(capped.events, 'error').length, 0);
  assert.equal(capped.events.at(-1)!.type, 'done');
  const broken = await turn(req({ images: [IMG] }), { results: { job_fetcher: async () => { throw new Error('boom with internal detail'); } } });
  const err = of(broken.events, 'error')[0];
  assert.ok(err && !err.message.includes('internal detail'));
  assert.equal(broken.events.at(-1)!.type, 'done');
});

test('done sums step costs', async () => {
  const llm = fakeChat([routerJson([intent('show_top', 0.9)])]);
  const sumEvents: StreamEvent[] = [];
  const ex = fakeExperts({
    job_fetcher: async () => {
      return {};
    },
  });
  // The fake LLM does not emit steps, so emit them the way nebius.chat would.
  const wrapped = (async (call: Parameters<typeof llm>[0]) => {
    const r = await llm(call);
    call.emit?.({ type: 'step', expert: 'router', label: call.label ?? '', costUsd: 0.002, status: 'ok' });
    return r;
  }) as typeof llm;
  await runTurn(fakeSql(), req({ text: 'what should I apply to today?' }), (e) => sumEvents.push(e), { llm: wrapped, tavily: fakeTavily(), experts: ex.experts, budget: normal });
  const done = sumEvents.at(-1)!;
  assert.ok(done.type === 'done' && Math.abs(done.totalCostUsd - 0.002) < 1e-9);
  assert.deepEqual(ex.calls.map((c) => c.req.action), ['show_top']);
});

// ---- pure helpers ----

test('parseRouterOut cleans model output: expert follows action, confidence clamped, max 3, bad JSON is empty', () => {
  const r = parseRouterOut('```json\n{"intents":[{"expert":"outreach","action":"tailor","confidence":1.4,"args":{"company":"","appRef":"last","person":"","note":"","url":""}},{"action":"nope"},{"action":"show_top","confidence":0.2,"args":{}},{"action":"add_lead","confidence":0.1,"args":{}},{"action":"show_top","confidence":0.1,"args":{}}],"clarify":"","reply":"hi"}\n```');
  assert.equal(r.intents.length, 3);
  assert.equal(r.intents[0].expert, 'resume');
  assert.equal(r.intents[0].confidence, 1);
  assert.equal(r.intents[0].args.company, undefined);
  assert.equal(r.intents[0].args.appRef, 'last');
  assert.deepEqual(parseRouterOut('not json'), { intents: [], clarify: '', reply: '' });
});

test('sortIntents puts add_lead before tailor among sure intents', () => {
  const s = sortIntents([
    { expert: 'resume', action: 'tailor', confidence: 0.95, args: {} },
    { expert: 'job_fetcher', action: 'add_lead', confidence: 0.8, args: {} },
    { expert: 'outreach', action: 'find_contact_and_draft', confidence: 0.5, args: {} },
  ]);
  assert.deepEqual(s.map((i) => i.action), ['add_lead', 'tailor', 'find_contact_and_draft']);
});

test('actionLabel', () => {
  assert.equal(actionLabel({ expert: 'job_fetcher', action: 'search_company', args: { company: 'Grab' } }), 'Search Grab');
  assert.equal(actionLabel({ expert: 'outreach', action: 'find_contact_and_draft', args: {} }), 'Find someone to ask');
});

test('parseChatRequest enforces the limits', () => {
  assert.equal(parseChatRequest({ text: 'hi' }).ok, true);
  assert.equal(parseChatRequest({ text: 'x'.repeat(8001) }).ok, false);
  assert.equal(parseChatRequest({ text: 'hi', images: [IMG, IMG, IMG, IMG] }).ok, false);
  assert.equal(parseChatRequest({ images: [{ mime: 'image/gif', b64: 'AAAA' }] }).ok, false);
  assert.equal(parseChatRequest({ images: [{ mime: 'image/png', b64: 'A'.repeat(1.5 * 1024 * 1024 + 4) }] }).ok, false);
  assert.equal(parseChatRequest({ text: 'hi', history: Array(5).fill({ role: 'user', summary: 'x' }) }).ok, false);
  assert.equal(parseChatRequest({ text: 'hi', history: [{ role: 'user', summary: 'x'.repeat(201) }] }).ok, false);
  assert.equal(parseChatRequest({ text: 'hi', lastAppId: -1 }).ok, false);
  assert.equal(parseChatRequest({ action: { expert: 'resume', action: 'show_top', args: {} } }).ok, false);
  assert.equal(parseChatRequest({ text: '' }).ok, false);
  const ok = parseChatRequest({ images: [{ mime: 'image/png', b64: 'data:image/png;base64,iVBORw0KGgo=' }], action: { expert: 'resume', action: 'tailor', args: { appId: 3, note: 'x' } }, lastAppId: 3 });
  assert.ok(ok.ok && ok.req.images[0].b64 === 'iVBORw0KGgo=' && ok.req.action?.args.appId === 3 && ok.req.lastAppId === 3);
});
