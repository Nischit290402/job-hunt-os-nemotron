/**
 * Tavily Search and Extract. Never LinkedIn: linkedin.com and lnkd.in are always excluded and never extracted.
 * Every call counts against TAVILY_DAILY_CAP (kv tavily_<SGT date>) and writes a runs row.
 */
import type { Sql } from './sql';
import type { TavilyClient, WebResult } from '../agents/types';
import { env } from './env';
import * as repo from './repo';
import { httpGet, httpPost } from './http';
import { isLinkedInUrl } from '../core/lead';
import { htmlToText } from '../core/html';
import { sgtDate } from '../core/time';

export const EXCLUDE_DOMAINS: string[] = [
  'linkedin.com', 'lnkd.in', 'glassdoor.com', 'glassdoor.sg', 'indeed.com', 'sg.indeed.com', 'jobstreet.com', 'jobstreet.com.sg',
  'mycareersfuture.gov.sg', 'ziprecruiter.com', 'simplyhired.com', 'talent.com', 'jooble.org', 'nodeflair.com', 'efinancialcareers.com',
  'wellfound.com', 'prosple.com', 'himalayas.app', 'builtin.com', 'reddit.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'youtube.com',
];

export const ATS_DOMAINS: string[] = [
  'greenhouse.io', 'job-boards.greenhouse.io', 'boards.greenhouse.io', 'lever.co', 'jobs.lever.co', 'ashbyhq.com', 'jobs.ashbyhq.com',
  'myworkdayjobs.com', 'smartrecruiters.com', 'workable.com',
];

const SEARCH_URL = 'https://api.tavily.com/search';
const EXTRACT_URL = 'https://api.tavily.com/extract';
const TIMEOUT_MS = 20_000;
const MAX_TEXT = 20_000;
const NEVER = ['linkedin.com', 'lnkd.in'];

const normDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/** Exact host or a subdomain of it ("x.com" must not match "dropbox.com"). */
const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function hostOf(u: string): string | null {
  try {
    return new URL(u.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True for anything we must never fetch or return: LinkedIn, lnkd.in, aggregators and social sites, or a malformed URL. */
export function isBlockedUrl(u: string): boolean {
  if (isLinkedInUrl(u)) return true;
  const host = hostOf(u);
  if (!host) return true;
  return EXCLUDE_DOMAINS.some((d) => hostMatches(host, d));
}

const isLinkedInDomain = (d: string) => NEVER.some((n) => hostMatches(normDomain(d), n));

async function countCall(sql: Sql) {
  const n = await repo.kvIncrement(sql, `tavily_${sgtDate()}`);
  if (n > env.tavilyDailyCap()) throw new Error('Tavily daily cap reached');
}

async function logRun(sql: Sql, step: string, started: number, ok: boolean, count: number, error?: string) {
  try {
    await repo.recordRun(sql, { step, seconds: (Date.now() - started) / 1000, ok, error: error ?? null, detail: { count } });
  } catch {
    // a failed log line must never fail the search itself
  }
}

export async function tavilySearch(sql: Sql, q: string, o: Parameters<TavilyClient['search']>[1] = {}): Promise<WebResult[]> {
  const key = env.tavilyKey();
  if (!key) return [];

  let include: string[] | undefined;
  if (o.includeDomains?.length) {
    include = [...new Set(o.includeDomains.map(normDomain).filter((d) => d && !isLinkedInDomain(d)))];
    // A list that was only LinkedIn must not widen into an unrestricted search.
    if (!include.length) return [];
  }
  const exclude = [...new Set([...EXCLUDE_DOMAINS, ...(o.excludeDomains ?? []).map(normDomain).filter(Boolean)])];

  await countCall(sql);
  const started = Date.now();
  const body: Record<string, unknown> = {
    query: q,
    search_depth: o.depth ?? 'basic',
    max_results: o.maxResults ?? 8,
    exclude_domains: exclude,
  };
  if (include) body.include_domains = include;

  const r = await httpPost(SEARCH_URL, body, { authorization: `Bearer ${key}` }, TIMEOUT_MS, false);
  if (r.status !== 200) {
    const err = r.error ?? `HTTP ${r.status}`;
    await logRun(sql, 'tavily:search', started, false, 0, err);
    throw new Error(`Tavily search failed: ${err}`);
  }
  let results: WebResult[] = [];
  try {
    const data = JSON.parse(r.text) as { results?: { title?: string; url?: string; content?: string }[] };
    results = (data.results ?? [])
      .filter((x) => typeof x.url === 'string' && x.url && !isBlockedUrl(x.url))
      .map((x) => ({ title: String(x.title ?? ''), url: String(x.url), description: String(x.content ?? '') }));
  } catch {
    await logRun(sql, 'tavily:search', started, false, 0, 'bad JSON');
    throw new Error('Tavily search failed: bad JSON');
  }
  await logRun(sql, 'tavily:search', started, true, results.length);
  return results;
}

/** Plain fetch of a public page, used when Tavily is off or failed. Callers have already removed blocked URLs. */
async function fetchDirect(urls: string[]): Promise<{ url: string; text: string }[]> {
  const out = await Promise.all(
    urls.map(async (url) => {
      const r = await httpGet(url, {}, TIMEOUT_MS);
      if (r.status < 200 || r.status >= 300 || !r.text) return null;
      const text = htmlToText(r.text).slice(0, MAX_TEXT);
      return text ? { url, text } : null;
    }),
  );
  return out.filter((x): x is { url: string; text: string } => x !== null);
}

export async function tavilyExtract(sql: Sql, urls: string[]): Promise<{ url: string; text: string }[]> {
  // The LinkedIn block happens here, before any request is built.
  const safe = [...new Set(urls.map((u) => String(u ?? '').trim()).filter((u) => u && !isBlockedUrl(u)))];
  if (!safe.length) return [];

  const key = env.tavilyKey();
  if (!key) return fetchDirect(safe);

  await countCall(sql);
  const started = Date.now();
  const r = await httpPost(EXTRACT_URL, { urls: safe, extract_depth: 'basic' }, { authorization: `Bearer ${key}` }, TIMEOUT_MS, false);

  let got: { url: string; text: string }[] = [];
  let error: string | undefined;
  if (r.status === 200) {
    try {
      const data = JSON.parse(r.text) as { results?: { url?: string; raw_content?: string }[] };
      got = (data.results ?? [])
        .filter((x) => typeof x.url === 'string' && x.url && !isBlockedUrl(x.url) && x.raw_content)
        .map((x) => ({ url: String(x.url), text: String(x.raw_content).slice(0, MAX_TEXT) }));
    } catch {
      error = 'bad JSON';
    }
  } else {
    error = r.error ?? `HTTP ${r.status}`;
  }
  await logRun(sql, 'tavily:extract', started, !error, got.length, error);

  // Any URL Tavily could not read gets one direct fetch.
  const have = new Set(got.map((g) => g.url));
  const missing = safe.filter((u) => !have.has(u));
  if (missing.length) got = [...got, ...(await fetchDirect(missing))];
  return got;
}

export const tavilyFor = (sql: Sql): TavilyClient => ({
  search: (q, o) => tavilySearch(sql, q, o),
  extract: (urls) => tavilyExtract(sql, urls),
});
