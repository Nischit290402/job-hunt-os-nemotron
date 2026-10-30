/** Nebius client: price math, output cleanup, retry rules and the USD budget guard. fetch is mocked: no live calls. */
import { test, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { budgetModeFor, costUsd, parseJsonLoose, stripThink } from '../src/core/models';
import { budgetMode, chat, LlmCapError, spendSummary } from '../src/server/nebius';
import { makeTestDb, pgAvailable } from './pg';
import { collect } from './fakes';
import type { Sql } from '../src/server/sql';
import type { LlmCall, StepEvent } from '../src/agents/types';
import { sgtDate } from '../src/core/time';

process.env.NEBIUS_API_KEY = 'test-key';
process.env.NEBIUS_BASE_URL = 'https://nebius.test/v1';
process.env.NEBIUS_MODEL_FAST = 'nvidia/test-Nano';
process.env.NEBIUS_MODEL_REASON = 'nvidia/test-Ultra';
process.env.NEBIUS_MODEL_VISION = 'nvidia/test-Super-VL';
process.env.NEBIUS_MODEL_FALLBACK = 'nvidia/test-Lightning';
process.env.LLM_DAILY_USD_CAP = '1';
process.env.LLM_TOTAL_USD_CAP = '15';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

/** Records runs inserts; answers the spend query with the given totals. */
function fakeSql(spend = { today: 0, total: 0 }) {
  const inserts: unknown[][] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (/INSERT INTO runs/i.test(q)) {
      inserts.push(values);
      return [];
    }
    if (/FROM runs/i.test(q)) return [{ today: spend.today, total: spend.total, calls: 0 }];
    return [];
  }) as Sql;
  return Object.assign(sql, { inserts });
}

type Reply = { status?: number; body: unknown };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(replies: Reply[]) {
  const reqs: { url: string; body: any; auth: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    reqs.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: h.authorization });
    const r = replies.shift();
    if (!r) throw new Error('unexpected fetch');
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return reqs;
}

const completion = (content: string, extra: Record<string, unknown> = {}) => ({
  body: { model: extra.model, choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } },
});

const schema = { name: 'verdict', schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } };
const base = (o: Partial<LlmCall> = {}): LlmCall => ({
  role: 'fast',
  messages: [{ role: 'system', content: 'Judge the job.' }, { role: 'user', content: 'job text' }],
  timeoutMs: 5000,
  tag: { expert: 'job_fetcher', step: 'judge' },
  ...o,
});

test('costUsd: per 1M token prices by model ID, unknown priced as Ultra', () => {
  near(costUsd('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', 1_000_000, 1_000_000), 0.3);
  near(costUsd('nvidia/Nemotron-3_5-Lightning', 1000, 500), 0.00006 + 0.00012);
  near(costUsd('nvidia/Nemotron-3.5-Super-VL', 1000, 500), 0.0003 + 0.00045);
  near(costUsd('nvidia/Nemotron-3-Ultra-550b-a55b', 1000, 500), 0.001 + 0.0015);
  near(costUsd('someone/new-model', 1000, 500), 0.0025);
});

test('stripThink and parseJsonLoose', () => {
  assert.equal(stripThink('<think>plan it</think>\nAnswer'), 'Answer');
  assert.equal(stripThink('reasoning here</think>{"a":1}'), '{"a":1}');
  assert.equal(stripThink('<think>\n{"a":1}'), '{"a":1}');
  assert.deepEqual(parseJsonLoose('```json\n{"a": [1, 2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('Sure! Here it is: {"s": "a } brace"} and more'), { s: 'a } brace' });
  assert.deepEqual(parseJsonLoose('list: [1, 2] done'), [1, 2]);
  assert.equal(parseJsonLoose('no json here'), undefined);
});

test('budgetModeFor: saver at 60% of daily, stopped at either cap', () => {
  assert.equal(budgetModeFor(0.59, 3, 1, 15), 'normal');
  assert.equal(budgetModeFor(0.6, 3, 1, 15), 'saver');
  assert.equal(budgetModeFor(1, 3, 1, 15), 'stopped');
  assert.equal(budgetModeFor(0.1, 15, 1, 15), 'stopped');
});

test('schema call: json_object request with the schema in the system message, parsed json, runs row, step event', async () => {
  const reqs = mockFetch([completion('{"score": 82}', { model: 'nvidia/test-Nano' })]);
  const sql = fakeSql();
  const { emit, events } = collect();
  const r = await chat(sql, base({ schema, thinking: false, label: 'Nano judged the job', emit }));
  assert.deepEqual(r.json, { score: 82 });
  assert.equal(reqs[0].url, 'https://nebius.test/v1/chat/completions');
  assert.equal(reqs[0].auth, 'Bearer test-key');
  assert.equal(reqs[0].body.model, 'nvidia/test-Nano');
  assert.equal(reqs[0].body.max_tokens, 800);
  assert.deepEqual(reqs[0].body.response_format, { type: 'json_object' });
  assert.match(JSON.stringify(reqs[0].body.messages[0]), /schema/i);
  assert.deepEqual(reqs[0].body.chat_template_kwargs, { enable_thinking: false });
  near(r.costUsd, 0.00006 + 0.00012);
  assert.deepEqual(r.usage, { in: 1000, out: 500 });
  assert.equal(r.fallbackUsed, false);
  assert.equal(sql.inserts.length, 1);
  const [step, , , ok, , detail, tin, tout] = sql.inserts[0];
  assert.equal(step, 'llm:job_fetcher:judge');
  assert.equal(ok, true);
  assert.equal(tin, 1000);
  assert.equal(tout, 500);
  assert.equal(JSON.parse(String(detail)).role, 'fast');
  const ev = events[0] as StepEvent;
  assert.equal(ev.type, 'step');
  assert.equal(ev.status, 'ok');
  assert.equal(ev.label, 'Nano judged the job');
  assert.equal(ev.model, 'nvidia/test-Nano');
});

test('400 on json_schema: one retry with json_object and the schema in the system message', async () => {
  const reqs = mockFetch([{ status: 400, body: 'response_format json_schema is not supported' }, completion('{"score": 5}')]);
  const r = await chat(fakeSql(), base({ schema }));
  assert.deepEqual(r.json, { score: 5 });
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs[1].body.response_format, { type: 'json_object' });
  assert.match(reqs[1].body.messages[0].content, /^Judge the job\.\n\nReply with JSON matching this schema: /);
  assert.equal(r.fallbackUsed, false);
});

test('think blocks are stripped and tool call arguments parsed', async () => {
  mockFetch([completion('<think>long reasoning</think>Final answer', { tool_calls: [{ id: 't1', function: { name: 'ping', arguments: '{"x":1}' } }] })]);
  const r = await chat(fakeSql(), base());
  assert.equal(r.content, 'Final answer');
  assert.deepEqual(r.toolCalls, [{ id: 't1', name: 'ping', args: { x: 1 } }]);
});

test('404 moves to the fallback model and marks fallbackUsed', async () => {
  const reqs = mockFetch([{ status: 404, body: 'model not found' }, completion('ok')]);
  const { emit, events } = collect();
  const r = await chat(fakeSql(), base({ role: 'reason', label: 'Ultra judged', emit }));
  assert.equal(reqs[0].body.model, 'nvidia/test-Ultra');
  assert.equal(reqs[1].body.model, 'nvidia/test-Lightning');
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.model, 'nvidia/test-Lightning');
  assert.equal((events[0] as StepEvent).status, 'fallback');
});

test('bad JSON: one repair call on the fast model', async () => {
  const reqs = mockFetch([completion('I think the score is high'), completion('{"score": 70}')]);
  const r = await chat(fakeSql(), base({ role: 'reason', schema }));
  assert.deepEqual(r.json, { score: 70 });
  assert.equal(reqs[1].body.model, 'nvidia/test-Nano');
  assert.equal(reqs[1].body.max_tokens, 600);
  assert.deepEqual(r.usage, { in: 2000, out: 1000 });
  near(r.costUsd, 0.0025 + 0.00018);
});

test('still bad after repair: throws, failure row written, error step emitted', async () => {
  mockFetch([completion('nope'), completion('still nope')]);
  const sql = fakeSql();
  const { emit, events } = collect();
  await assert.rejects(chat(sql, base({ schema, label: 'x', emit })), /model returned invalid JSON/);
  assert.equal(sql.inserts.length, 1);
  assert.equal(sql.inserts[0][3], false);
  assert.equal((events[0] as StepEvent).status, 'error');
});

test('budget stopped: LlmCapError and fetch is never called', async () => {
  const reqs = mockFetch([]);
  const sql = fakeSql({ today: 1.2, total: 2 });
  await assert.rejects(chat(sql, base()), (e: unknown) => e instanceof LlmCapError);
  assert.equal(reqs.length, 0);
  assert.equal(sql.inserts.length, 0);
  await assert.rejects(chat(fakeSql({ today: 0, total: 15 }), base()), LlmCapError);
});

test('budget saver: a reason call runs on the fast model', async () => {
  const reqs = mockFetch([completion('ok')]);
  const { emit, events } = collect();
  const r = await chat(fakeSql({ today: 0.7, total: 2 }), base({ role: 'reason', label: 'Ultra judged', emit }));
  assert.equal(reqs[0].body.model, 'nvidia/test-Nano');
  assert.equal(r.role, 'fast');
  assert.equal(r.fallbackUsed, true);
  assert.equal((events[0] as StepEvent).label, 'Ultra judged (budget saver)');
});

const ok = pgAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: ok ? false : 'no Postgres reachable' }, fn);
let db: ReturnType<typeof makeTestDb> | null = null;
before(() => {
  if (ok) db = makeTestDb();
});
after(() => db?.drop());

t('spendSummary and budgetMode on the real runs table', async () => {
  const sql = db!.sql;
  const today = sgtDate();
  const row = (cost: number, role: string, ok: boolean, ago = '0 days') =>
    sql`INSERT INTO runs (step, started_at, ok, detail) VALUES ('llm:x:y', now() - ${ago}::interval, ${ok}, ${JSON.stringify({ costUsd: cost, role })}::jsonb)`;
  await row(0.2, 'fast', true);
  await row(0.1, 'reason', true);
  await row(0, 'reason', false);
  await row(3, 'vision', true, '3 days');
  await sql`INSERT INTO runs (step, ok, detail) VALUES ('collect', true, ${JSON.stringify({ costUsd: 50 })}::jsonb)`;
  const s = await spendSummary(sql, today);
  near(s.todayUsd, 0.3);
  near(s.totalUsd, 3.3);
  assert.equal(s.calls, 3);
  assert.deepEqual(s.byRole, { fast: 1, reason: 1, vision: 1 });
  assert.equal(s.dailyCapUsd, 1);
  assert.equal(await budgetMode(sql, today), 'normal');
  await row(0.4, 'fast', true);
  assert.equal(await budgetMode(sql, today), 'saver');
  await row(0.5, 'fast', true);
  assert.equal(await budgetMode(sql, today), 'stopped');
});
