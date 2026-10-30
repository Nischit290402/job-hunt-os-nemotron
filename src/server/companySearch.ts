/**
 * /search <company>: looks for the company's open roles right now and adds the ones that fit to your jobs.
 * Order: the career-page sources you already track for it, the public Greenhouse / Lever / Ashby boards under its
 * name, then a web search for its postings (hiring-system pages and its own careers site). Never LinkedIn.
 * Each part is one Inngest step; the report goes to Telegram at the end.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { httpGet } from './http';
import { env } from './env';
import { collectSource } from './collector';
import { braveSearch } from './search';
import { buildRules, evaluateJob, jobTypeOf, type RawJob } from '../core/filters';
import { DEFAULT_TERMS, withExtraTerms } from '../core/terms';
import { BOARD_APIS, boardSlugs } from '../core/route';
import { postingFromResult, searchQueries, type SearchReport } from '../core/companySearch';
import { searchName } from '../core/contacts';
import { isLinkedInUrl } from '../core/lead';
import * as tavilyLib from './tavily';
import type { TavilyClient } from '../agents/types';

export type Part = Pick<SearchReport, 'checked' | 'listed' | 'kept' | 'newJobs' | 'rejected' | 'added' | 'notes'>;

const empty = (): Part => ({ checked: [], listed: 0, kept: 0, newJobs: 0, rejected: {}, added: [], notes: [] });

/** Sources you already track whose company matches the name you typed ("google" finds Google and Google DeepMind). */
export async function matchingSources(sql: Sql, company: string): Promise<{ id: string; company: string }[]> {
  const q = searchName(company).toLowerCase();
  if (q.length < 2) return [];
  return sql`SELECT id, company FROM sources WHERE enabled AND type NOT IN ('mcf', 'freehire', 'mdlist')
             AND (lower(company) = ${q} OR lower(company) LIKE ${q + ' %'} OR lower(company) LIKE ${q + '%'}) ORDER BY id LIMIT 8`;
}

export async function searchTrackedSources(sql: Sql, company: string, today: string): Promise<Part> {
  const out = empty();
  const sources = await matchingSources(sql, company);
  for (const s of sources) {
    const r = await collectSource(sql, s.id, today, Date.now(), { searched: true });
    out.listed += r.listed;
    out.kept += r.kept;
    out.newJobs += r.newJobs;
    for (const [k, n] of Object.entries(r.rejected)) out.rejected[k] = (out.rejected[k] ?? 0) + n;
    out.added.push(...r.jobIds);
    if (r.status !== 'ok') out.notes.push(`${s.id}: ${r.status} (${r.note})`);
  }
  if (sources.length) out.checked.push(`${sources.length} career page${sources.length === 1 ? '' : 's'} you track (${[...new Set(sources.map((s) => s.company))].join(', ')})`);
  return out;
}

async function keep(sql: Sql, raw: RawJob, today: string, out: Part) {
  const prefs = await repo.preferenceBundle(sql);
  const rules = buildRules(withExtraTerms(DEFAULT_TERMS, { exclude: prefs.exclude, archive: prefs.archive }));
  out.listed++;
  const d = evaluateJob({ ...raw, searched: true }, rules);
  if (d.action === 'reject') {
    out.rejected[d.reason] = (out.rejected[d.reason] ?? 0) + 1;
    return;
  }
  const r = await repo.upsertJob(sql, raw, d, null, today);
  out.kept++;
  if (r.isNew) out.newJobs++;
  out.added.push({ jobId: r.jobId, isNew: r.isNew, title: raw.title, type: jobTypeOf(d.track, d.hoursFlag) });
}

/** Public Greenhouse, Lever and Ashby boards under the company's name. Exact and free; most companies have none. */
export async function searchBoards(sql: Sql, company: string, today: string): Promise<Part> {
  const out = empty();
  const name = searchName(company);
  const found: string[] = [];
  for (const api of BOARD_APIS) {
    for (const s of boardSlugs(company)) {
      const r = await httpGet(api.url(s), {}, 12_000);
      if (r.status !== 200) continue;
      let postings: ReturnType<typeof api.parse> = [];
      try {
        postings = api.parse(r.text, s);
      } catch {
        continue;
      }
      if (!postings.length) continue;
      found.push(`${api.name}/${s}`);
      for (const p of postings.slice(0, 300)) {
        await keep(sql, { company: name, title: p.title, location: p.location, url: p.url, posted: '', channel: 'ATS', remote: /remote/i.test(p.location) }, today, out);
      }
      break; // one slug per board is enough
    }
  }
  out.checked.push(found.length ? `job boards (${found.join(', ')})` : 'Greenhouse, Lever and Ashby boards (none under this name)');
  return out;
}

/** Tavily queries: hiring-system pages first (domain-filtered instead of site: operators), then the careers site. */
export function tavilyQueries(company: string): { q: string; includeDomains?: string[] }[] {
  const n = searchName(company);
  return [
    { q: `"${n}" intern OR internship OR engineer OR scientist Singapore`, includeDomains: atsDomains() },
    { q: searchQueries(company)[1] },
  ];
}

// ATS_DOMAINS comes from tavily.ts (sub-agent B1); read through the namespace so this compiles before that merge.
export function atsDomains(): string[] {
  const d = (tavilyLib as unknown as Record<string, unknown>).ATS_DOMAINS;
  return Array.isArray(d) && d.length ? (d as string[]) : ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'smartrecruiters.com', 'workable.com'];
}

/**
 * Web search for single postings on hiring systems or the company's own careers site.
 * Provider: Tavily when a client is passed and TAVILY_API_KEY is set (Nebius branch), else Brave as before.
 */
export async function searchWeb(sql: Sql, company: string, today: string, tavily?: TavilyClient): Promise<Part> {
  if (tavily && env.tavilyKey()) return searchWebTavily(sql, company, today, tavily);
  const out = empty();
  if (!env.braveKey()) {
    out.notes.push('Web search is off (no BRAVE_SEARCH_API_KEY).');
    return out;
  }
  const name = searchName(company);
  const seen = new Set<string>();
  let results = 0;
  for (const q of searchQueries(company)) {
    const rs = await braveSearch(q, 20).catch((e: Error) => {
      out.notes.push(`Web search failed: ${e.message.slice(0, 120)}`);
      return [];
    });
    results += rs.length;
    for (const r of rs) {
      const p = postingFromResult(r, company);
      if (!p || seen.has(p.url)) continue;
      seen.add(p.url);
      await keep(sql, { company: name, title: p.title, location: p.location, url: p.url, posted: '', channel: p.ats ? 'ATS' : 'CRAWL', remote: p.location === 'Remote' }, today, out);
    }
  }
  out.checked.push(`web search (${results} results, ${seen.size} looked like ${name} postings)`);
  return out;
}

async function searchWebTavily(sql: Sql, company: string, today: string, tavily: TavilyClient): Promise<Part> {
  const out = empty();
  const name = searchName(company);
  const seen = new Set<string>();
  let results = 0;
  for (const { q, includeDomains } of tavilyQueries(company)) {
    const rs = await tavily.search(q, { includeDomains, maxResults: 10 }).catch((e: Error) => {
      out.notes.push(`Web search failed: ${e.message.slice(0, 120)}`);
      return [];
    });
    results += rs.length;
    for (const r of rs) {
      if (isLinkedInUrl(r.url)) continue;
      const p = postingFromResult(r, company);
      if (!p || seen.has(p.url)) continue;
      seen.add(p.url);
      await keep(sql, { company: name, title: p.title, location: p.location, url: p.url, posted: '', channel: p.ats ? 'ATS' : 'CRAWL', remote: p.location === 'Remote' }, today, out);
    }
  }
  out.checked.push(`Tavily web search, LinkedIn excluded (${results} results, ${seen.size} looked like ${name} postings)`);
  return out;
}

export function merge(company: string, parts: Part[]): SearchReport {
  const r: SearchReport = { company, ...empty() };
  const ids = new Set<number>();
  for (const p of parts) {
    r.checked.push(...p.checked);
    r.listed += p.listed;
    r.notes.push(...p.notes);
    for (const [k, n] of Object.entries(p.rejected)) r.rejected[k] = (r.rejected[k] ?? 0) + n;
    for (const a of p.added) {
      if (ids.has(a.jobId)) continue; // the same job from two places counts once
      ids.add(a.jobId);
      r.added.push(a);
    }
  }
  r.kept = r.added.length;
  r.newJobs = r.added.filter((a) => a.isNew).length;
  return r;
}
