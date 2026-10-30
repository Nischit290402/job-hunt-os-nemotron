/**
 * Context separation: the router sees only the message, flags, the last 4 summaries and {id, company, title} of the
 * verified last job. Experts see the message and images, never the history. Checked on what the fakes received.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChat, fakeTavily, collect } from './fakes';
import { runTurn, type IntakeLike } from '../src/agents/orchestrator';
import { routerUserContent, ROUTER_LABEL } from '../src/agents/router';
import type { ChatRequest, Expert, ExpertId, OpenAIMessage } from '../src/agents/types';
import type { Sql } from '../src/server/sql';

const JD_MARKER = 'JD_SECRET_MARKER_7781';
const classify = (req: ChatRequest): IntakeLike => ({ rule: req.images.length ? 'R1' : 'R0', urls: [], linkedinUrls: [], hasImages: req.images.length > 0, looksLikeJd: false });

function fakeSql() {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    queries.push(q);
    if (/FROM applications a JOIN jobs j/.test(q) && /WHERE a\.id =/.test(q) && Number(values[0]) === 7) {
      return [{ id: 7, job_id: 70, state: 'today', company: 'Acme', company_id: 1, company_key: 'acme', title: 'ML Intern', url: 'https://acme.test/7', listing_url: 'https://acme.test/7', jd_text: JD_MARKER, apply_email: 'hr@acme.test' }];
    }
    return [];
  }) as unknown as Sql;
  return { sql, queries };
}

function experts() {
  const seen: { id: ExpertId; input: ChatRequest }[] = [];
  const mk = (id: ExpertId): Expert => ({
    id,
    describe: () => ({ purpose: id, sees: [], neverSees: [], models: [], tools: [] }),
    run: async (_c, _r, input) => {
      seen.push({ id, input });
      return {};
    },
  });
  return { seen, experts: { job_fetcher: mk('job_fetcher'), resume: mk('resume'), outreach: mk('outreach') } };
}

const text = (m: OpenAIMessage) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

test('the router call carries only the allowed slice', async () => {
  const llm = fakeChat([{ json: { intents: [{ expert: 'outreach', action: 'find_contact_and_draft', confidence: 0.9, args: { company: '', appRef: 'last', person: '', note: '', url: '' } }], clarify: '', reply: '' } }]);
  const { sql, queries } = fakeSql();
  const ex = experts();
  const history = [1, 2, 3, 4, 5, 6].map((i) => ({ role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant', summary: `turn-${i}` }));
  const long = 'draft a referral ask for this ' + 'z'.repeat(3000);
  const { emit } = collect();
  await runTurn(sql, { text: long, images: [], history, lastAppId: 7 }, emit, { llm, tavily: fakeTavily(), experts: ex.experts, budget: 'normal', classify });

  assert.equal(llm.calls.length, 1);
  const call = llm.calls[0];
  assert.equal(call.role, 'fast');
  assert.equal(call.maxTokens, 300);
  assert.equal(call.temperature, 0);
  assert.equal(call.thinking, false);
  assert.equal(call.label, ROUTER_LABEL);
  assert.equal(call.messages.length, 2);
  assert.match(text(call.messages[0]), /untrusted/i);

  const user = JSON.parse(text(call.messages[1]));
  assert.deepEqual(Object.keys(user).sort(), ['hasLinkedInUrl', 'hasUrl', 'history', 'images', 'lastApp', 'message']);
  assert.equal(user.message.length, 2000);
  assert.deepEqual(user.history.map((h: { summary: string }) => h.summary), ['turn-3', 'turn-4', 'turn-5', 'turn-6']);
  assert.deepEqual(user.lastApp, { id: 7, company: 'Acme', title: 'ML Intern' });

  const all = call.messages.map(text).join('\n');
  for (const banned of [JD_MARKER, 'hr@acme.test', 'master_resume', 'turn-1', 'turn-2']) assert.ok(!all.includes(banned), `router saw ${banned}`);

  // No memory beyond the application lookup was read for this turn.
  for (const q of queries) assert.ok(!/\b(kv|profile|contacts|judgments|preferences|resume_versions|messages)\b/.test(q), `unexpected query: ${q}`);

  // The expert got the message, not the history.
  assert.equal(ex.seen.length, 1);
  assert.equal(ex.seen[0].id, 'outreach');
  assert.deepEqual(ex.seen[0].input.history, []);
  assert.equal(ex.seen[0].input.text, long);
});

test('the router never receives image bytes, only a count', async () => {
  const llm = fakeChat([{ json: { intents: [], clarify: '', reply: '' } }]);
  const { sql } = fakeSql();
  const ex = experts();
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  await runTurn(sql, { text: 'tailor my resume and find someone', images: [{ mime: 'image/png', b64 }], history: [] }, () => {}, { llm, tavily: fakeTavily(), experts: ex.experts, budget: 'normal', classify });
  assert.equal(llm.calls.length, 1);
  const all = llm.calls[0].messages.map(text).join('\n');
  assert.ok(!all.includes(b64));
  assert.ok(!all.includes('image_url'));
  assert.equal(JSON.parse(text(llm.calls[0].messages[1])).images, 1);
  assert.equal(ex.seen[0].input.images[0].b64, b64, 'the Job Fetcher gets the image');
});

test('routerUserContent clips summaries and omits lastApp when not verified', () => {
  const c = JSON.parse(routerUserContent({ text: 'hi', images: [], history: [{ role: 'user', summary: 'a'.repeat(500) }] }, { rule: 'R0', urls: [], linkedinUrls: [], hasImages: false }, null));
  assert.equal(c.history[0].summary.length, 200);
  assert.equal(c.lastApp, null);
});
