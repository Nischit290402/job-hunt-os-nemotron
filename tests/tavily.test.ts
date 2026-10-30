/** Tavily client: LinkedIn never fetched, exclude list always sent, daily cap, extract fallback. fetch is mocked; no network. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from '../src/server/sql';
import { tavilySearch, tavilyExtract, tavilyFor, EXCLUDE_DOMAINS, ATS_DOMAINS, isBlockedUrl } from '../src/server/tavily';

interface Call {
  url: string;
  body: string;
  auth: string;
}

let calls: Call[] = [];
let handler: (url: string, body: unknown) => { status: number; body: unknown };
const realFetch = globalThis.fetch;
const savedEnv = { key: process.env.TAVILY_API_KEY, cap: process.env.TAVILY_DAILY_CAP };

/** Fake Sql: a kv counter for the daily cap and a list of runs rows. */
function fakeSql() {
  const state = { counter: 0, runs: [] as string[] };
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (/INSERT INTO kv/i.test(q)) return [{ value: ++state.counter }];
    if (/INSERT INTO runs/i.test(q)) {
      state.runs.push(String(values[0]));
      return [];
    }
    return [];
  }) as Sql;
  return { sql, state };
}

beforeEach(() => {
  calls = [];
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.TAVILY_DAILY_CAP = '150';
  handler = () => ({ status: 200, body: { results: [] } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, auth: headers.authorization ?? '' });
    const r = handler(url, body ? JSON.parse(body) : undefined);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv.key === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedEnv.key;
  if (savedEnv.cap === undefined) delete process.env.TAVILY_DAILY_CAP;
  else process.env.TAVILY_DAILY_CAP = savedEnv.cap;
});

const noLinkedIn = () => {
  for (const c of calls) {
    assert.ok(!/linkedin|lnkd/i.test(c.url), `fetch URL hit LinkedIn: ${c.url}`);
    assert.ok(!/linkedin|lnkd/i.test(c.body), `fetch body mentions LinkedIn: ${c.body}`);
  }
};

test('domain lists are the plan lists', () => {
  assert.ok(EXCLUDE_DOMAINS.includes('linkedin.com') && EXCLUDE_DOMAINS.includes('lnkd.in') && EXCLUDE_DOMAINS.length === 25);
  assert.ok(ATS_DOMAINS.includes('boards.greenhouse.io') && ATS_DOMAINS.length === 10);
  assert.ok(isBlockedUrl('https://www.linkedin.com/posts/x') && isBlockedUrl('https://sg.linkedin.com/jobs/1') && isBlockedUrl('https://lnkd.in/abc'));
  assert.ok(isBlockedUrl('https://x.com/a') && !isBlockedUrl('https://www.dropbox.com/jobs'));
  assert.ok(!isBlockedUrl('https://boards.greenhouse.io/acme/jobs/1'));
});

test('search: bearer auth, exclude_domains always has LinkedIn, include_domains strips LinkedIn, results filtered', async () => {
  const { sql, state } = fakeSql();
  handler = () => ({
    status: 200,
    body: {
      results: [
        { title: 'ML Intern', url: 'https://boards.greenhouse.io/acme/jobs/1', content: 'Build models' },
        { title: 'Post', url: 'https://www.linkedin.com/posts/jane_1', content: 'hiring' },
        { title: 'Short', url: 'https://lnkd.in/abc', content: 'x' },
        { title: 'Agg', url: 'https://sg.indeed.com/viewjob?jk=1', content: 'x' },
      ],
    },
  });
  const res = await tavilySearch(sql, '"Acme" machine learning intern', { includeDomains: ['linkedin.com', 'www.linkedin.com', 'greenhouse.io'], excludeDomains: ['example.org'], maxResults: 5 });
  assert.deepEqual(res, [{ title: 'ML Intern', url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Build models' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].auth, 'Bearer tvly-test');
  const body = JSON.parse(calls[0].body);
  assert.ok(body.exclude_domains.includes('linkedin.com') && body.exclude_domains.includes('lnkd.in') && body.exclude_domains.includes('example.org'));
  assert.deepEqual(body.include_domains, ['greenhouse.io']);
  assert.equal(body.search_depth, 'basic');
  assert.equal(body.max_results, 5);
  assert.equal(state.counter, 1);
  assert.deepEqual(state.runs, ['tavily:search']);
});

test('search: exclude_domains has LinkedIn even with no options; LinkedIn-only include list makes no call', async () => {
  const { sql } = fakeSql();
  await tavilySearch(sql, 'q');
  const body = JSON.parse(calls[0].body);
  assert.ok(body.exclude_domains.includes('linkedin.com'));
  assert.equal(body.include_domains, undefined);
  assert.equal(body.max_results, 8);
  calls = [];
  assert.deepEqual(await tavilySearch(sql, 'q', { includeDomains: ['linkedin.com', 'lnkd.in'] }), []);
  assert.equal(calls.length, 0);
});

test('search: no key returns [] with no network call', async () => {
  delete process.env.TAVILY_API_KEY;
  const { sql } = fakeSql();
  assert.deepEqual(await tavilySearch(sql, 'q'), []);
  assert.equal(calls.length, 0);
});

test('daily cap: the call over the cap throws before any fetch', async () => {
  process.env.TAVILY_DAILY_CAP = '2';
  const { sql } = fakeSql();
  await tavilySearch(sql, 'a');
  await tavilySearch(sql, 'b');
  await assert.rejects(() => tavilySearch(sql, 'c'), /Tavily daily cap reached/);
  await assert.rejects(() => tavilyExtract(sql, ['https://acme.com/jobs/1']), /Tavily daily cap reached/);
  assert.equal(calls.length, 2);
});

test('extract: LinkedIn and excluded URLs never reach fetch', async () => {
  const { sql } = fakeSql();
  handler = (_url, body) => ({
    status: 200,
    body: { results: (body as { urls: string[] }).urls.map((u) => ({ url: u, raw_content: `text of ${u}` })) },
  });
  const res = await tavilyExtract(sql, [
    'https://www.linkedin.com/posts/jane_hiring-123',
    'https://sg.linkedin.com/jobs/view/1',
    'https://lnkd.in/gXyZ',
    'https://www.glassdoor.sg/job/1',
    'https://boards.greenhouse.io/acme/jobs/1',
  ]);
  assert.deepEqual(res, [{ url: 'https://boards.greenhouse.io/acme/jobs/1', text: 'text of https://boards.greenhouse.io/acme/jobs/1' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), { urls: ['https://boards.greenhouse.io/acme/jobs/1'], extract_depth: 'basic' });
  noLinkedIn();
});

test('extract: only LinkedIn URLs returns [] with zero fetch calls, with or without a key', async () => {
  const { sql, state } = fakeSql();
  assert.deepEqual(await tavilyExtract(sql, ['https://www.linkedin.com/feed/update/urn:li:activity:1', 'https://lnkd.in/x']), []);
  delete process.env.TAVILY_API_KEY;
  assert.deepEqual(await tavilyExtract(sql, ['https://linkedin.com/in/jane']), []);
  assert.equal(calls.length, 0);
  assert.equal(state.counter, 0);
});

test('extract: caps text at 20000 chars', async () => {
  const { sql } = fakeSql();
  handler = () => ({ status: 200, body: { results: [{ url: 'https://acme.com/jobs/1', raw_content: 'a'.repeat(30_000) }] } });
  const res = await tavilyExtract(sql, ['https://acme.com/jobs/1']);
  assert.equal(res[0].text.length, 20_000);
});

test('extract: falls back to a direct fetch when Tavily fails, and for URLs Tavily could not read', async () => {
  const { sql, state } = fakeSql();
  handler = (url) => {
    if (url === 'https://api.tavily.com/extract') return { status: 400, body: { detail: 'bad' } };
    return { status: 200, body: '<html><body><h1>ML Intern</h1><p>Build &amp; ship models.</p></body></html>' };
  };
  const res = await tavilyExtract(sql, ['https://acme.com/jobs/1', 'https://www.linkedin.com/posts/x']);
  assert.equal(res.length, 1);
  assert.equal(res[0].url, 'https://acme.com/jobs/1');
  assert.match(res[0].text, /ML Intern/);
  assert.match(res[0].text, /Build & ship models\./);
  assert.deepEqual(calls.map((c) => c.url), ['https://api.tavily.com/extract', 'https://acme.com/jobs/1']);
  assert.deepEqual(state.runs, ['tavily:extract']);
  noLinkedIn();

  calls = [];
  handler = (url) => {
    if (url === 'https://api.tavily.com/extract') return { status: 200, body: { results: [{ url: 'https://a.com/1', raw_content: 'from tavily' }], failed_results: [{ url: 'https://b.com/2' }] } };
    return { status: 200, body: '<p>direct</p>' };
  };
  const res2 = await tavilyExtract(sql, ['https://a.com/1', 'https://b.com/2']);
  assert.deepEqual(res2, [
    { url: 'https://a.com/1', text: 'from tavily' },
    { url: 'https://b.com/2', text: 'direct' },
  ]);
});

test('extract: no key uses the direct fetch for non-LinkedIn URLs only', async () => {
  delete process.env.TAVILY_API_KEY;
  const { sql, state } = fakeSql();
  handler = () => ({ status: 200, body: '<p>hello</p>' });
  const res = await tavilyFor(sql).extract(['https://acme.com/careers/2', 'https://lnkd.in/abc']);
  assert.deepEqual(res, [{ url: 'https://acme.com/careers/2', text: 'hello' }]);
  assert.deepEqual(calls.map((c) => c.url), ['https://acme.com/careers/2']);
  assert.equal(state.counter, 0);
  noLinkedIn();
});
