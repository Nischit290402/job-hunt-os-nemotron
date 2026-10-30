/**
 * Collector adapter: one call per source, so each source is its own workflow step with its own retries and time budget.
 * Fetch -> parse (core/sources) -> filter (core/filters) -> upsert (repo). A failed fetch never closes jobs.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { httpGet, httpPost } from './http';
import { scrape } from './firecrawl';
import { env } from './env';
import { buildRules, evaluateJob, jobTypeOf, type RawJob } from '../core/filters';
import { DEFAULT_TERMS, withExtraTerms } from '../core/terms';
import { canonicalKey } from '../core/keys';
import { ashby, channelOf, crawl, detailPlan, freehire, greenhouse, lever, mcf, mdlist, ParseError, smartrecruiters, workday, type SourceRow } from '../core/sources';
import { htmlToText } from '../core/html';

const MAX_NEW_PER_SOURCE = 150;
const MAX_CRAWL_PAGES = 3;

export interface CollectResult {
  sourceId: string;
  status: 'ok' | 'failed' | 'not_found' | 'skipped';
  note: string;
  listed: number;
  kept: number;
  newJobs: number;
  closed: number;
  credits: number;
  rejected: Record<string, number>;
}

async function fetchJobs(sql: Sql, s: SourceRow, today: string): Promise<{ jobs: RawJob[]; status: CollectResult['status']; note: string; credits: number }> {
  const one = async (url: string, headers: Record<string, string> | undefined, parse: (body: string) => RawJob[]) => {
    const r = await httpGet(url, headers);
    if (r.status === 404) return { status: 'not_found' as const, jobs: [], note: '404' };
    if (r.status !== 200) return { status: 'failed' as const, jobs: [], note: r.error ?? `HTTP ${r.status}` };
    try {
      return { status: 'ok' as const, jobs: parse(r.text), note: '' };
    } catch (e) {
      return { status: 'failed' as const, jobs: [], note: e instanceof ParseError ? e.message : String(e) };
    }
  };

  switch (s.type) {
    case 'greenhouse':
    case 'lever':
    case 'ashby':
    case 'mdlist': {
      const p = { greenhouse, lever, ashby, mdlist }[s.type];
      const [req] = p.requests(s);
      const r = await one(req.url, req.headers, (b) => (p.parse as (b: string, s: SourceRow) => RawJob[])(b, s));
      return { ...r, credits: 0 };
    }
    case 'smartrecruiters': {
      const jobs: RawJob[] = [];
      for (const [i, req] of smartrecruiters.requests(s).entries()) {
        const r = await one(req.url, req.headers, (b) => smartrecruiters.parse(b, s));
        if (r.status !== 'ok') return i === 0 ? { ...r, credits: 0 } : { status: 'ok', jobs, note: 'partial', credits: 0 };
        jobs.push(...r.jobs);
        if (r.jobs.length < 100) break;
      }
      return { status: 'ok', jobs, note: '', credits: 0 };
    }
    case 'workday': {
      const reqs = workday.requests(s);
      if (!reqs.length) return { status: 'failed', jobs: [], note: 'board url not recognised', credits: 0 };
      const jobs: RawJob[] = [];
      let okCount = 0;
      let last = '';
      let skipQuery = '';
      for (const req of reqs) {
        const q = req.tag!.split('#')[0];
        if (q === skipQuery) continue;
        const r = await httpPost(req.url, req.body, req.headers, 20_000);
        if (r.status !== 200) {
          last = `${q}: HTTP ${r.status || r.error}`;
          skipQuery = q;
          continue;
        }
        try {
          const page = workday.parse(r.text, s);
          okCount++;
          jobs.push(...page);
          if (page.length < 20) skipQuery = q; // last page for this search
        } catch (e) {
          last = `${q}: ${e instanceof Error ? e.message : e}`;
          skipQuery = q;
        }
      }
      if (!okCount) return { status: 'failed', jobs: [], note: last || 'no queries', credits: 0 };
      return { status: 'ok', jobs, note: `${okCount} pages ok`, credits: 0 };
    }
    case 'mcf':
    case 'freehire': {
      const p = s.type === 'mcf' ? mcf : freehire;
      const reqs = p.requests(s);
      const jobs: RawJob[] = [];
      let okCount = 0;
      let last = '';
      for (const req of reqs) {
        const r = await one(req.url, req.headers, (b) => p.parse(b));
        if (r.status === 'ok') {
          okCount++;
          jobs.push(...r.jobs);
        } else last = `${req.tag}: ${r.note}`;
      }
      if (!okCount) return { status: 'failed', jobs: [], note: last || 'no queries', credits: 0 };
      return { status: 'ok', jobs, note: `${okCount}/${reqs.length} queries ok`, credits: 0 };
    }
    case 'crawl': {
      if (!/^https?:\/\//.test(s.slug_or_url)) return { status: 'skipped', jobs: [], note: 'no url yet', credits: 0 };
      const jobs: RawJob[] = [];
      let credits = 0;
      const seen = new Set<string>();
      for (let page = 1; page <= MAX_CRAWL_PAGES; page++) {
        const url = crawl.pageUrl(s.slug_or_url, page);
        if (!url) break;
        const r = await scrape(sql, url, today);
        credits += r.credits;
        if (r.state !== 'ok') {
          if (page === 1) return { status: r.state === 'skipped' ? 'skipped' : 'failed', jobs: [], note: r.note, credits };
          break;
        }
        const found = crawl.parse(r.markdown, s).filter((j) => !seen.has(j.url));
        found.forEach((j) => seen.add(j.url));
        jobs.push(...found);
        if (found.length < 15) break; // a short page is the last page
      }
      return { status: 'ok', jobs, note: `credits ${credits}`, credits };
    }
  }
}

/** `searched`: run for /search, which keeps every relevant level and role family (see filters.evaluateJob). */
export async function collectSource(sql: Sql, sourceId: string, today: string, now = Date.now(), opts: { searched?: boolean } = {}): Promise<CollectResult & { jobIds: { jobId: number; isNew: boolean; title: string; type: string }[] }> {
  const started = Date.now();
  const s = await repo.getSource(sql, sourceId);
  if (!s || !s.enabled) {
    return { sourceId, status: 'skipped', note: 'disabled or missing', listed: 0, kept: 0, newJobs: 0, closed: 0, credits: 0, rejected: {}, jobIds: [] };
  }
  const prefs = await repo.preferenceBundle(sql);
  const rules = buildRules(withExtraTerms(DEFAULT_TERMS, { exclude: prefs.exclude, archive: prefs.archive }));

  const f = await fetchJobs(sql, s, today);
  const rejected: Record<string, number> = {};
  const sample: { title: string; reason: string }[] = [];
  let kept = 0;
  let newJobs = 0;
  const seenKeys = new Set<string>();
  const stillListed: string[] = [];
  const jobIds: { jobId: number; isNew: boolean; title: string; type: string }[] = [];
  for (const raw of f.jobs) {
    raw.channel = channelOf(s.type);
    if (s.track_hint) raw.hint = s.track_hint;
    if (opts.searched) raw.searched = true;
    const key = canonicalKey(raw);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const d = evaluateJob(raw, rules, now);
    if (d.action === 'reject') {
      stillListed.push(key); // a job you added with /search stays open while the source still lists it
      rejected[d.reason] = (rejected[d.reason] ?? 0) + 1;
      if (sample.length < 10 && d.reason !== 'empty_title') sample.push({ title: raw.title, reason: d.reason });
      continue;
    }
    kept++;
    if (newJobs >= MAX_NEW_PER_SOURCE) continue; // safety stop against a filter mistake; the rest arrive next run
    const r = await repo.upsertJob(sql, raw, d, s.id, today);
    if (r.isNew) newJobs++;
    jobIds.push({ jobId: r.jobId, isNew: r.isNew, title: raw.title, type: jobTypeOf(d.track, d.hoursFlag) });
  }
  if (f.status === 'ok' && stillListed.length) await repo.touchListed(sql, s.id, stillListed, today);
  const closed = f.status === 'ok' ? await repo.markMissing(sql, s.id, today) : 0;
  await repo.recordSourceResult(sql, s.id, f.status === 'ok' ? `ok${f.note ? ': ' + f.note : ''}` : `${f.status}: ${f.note}`, f.jobs.length, f.status === 'ok');
  await repo.recordRun(sql, {
    step: 'collect',
    sourceId: s.id,
    seconds: (Date.now() - started) / 1000,
    ok: f.status === 'ok' || f.status === 'skipped',
    error: f.status === 'ok' || f.status === 'skipped' ? null : f.note,
    credits: f.credits,
    detail: { listed: f.jobs.length, kept, new: newJobs, closed, rejected, rejected_sample: sample, note: f.note },
  });
  return { sourceId, status: f.status, note: f.note, listed: f.jobs.length, kept, newJobs, closed, credits: f.credits, rejected, jobIds };
}

/**
 * Fills missing job descriptions: API detail endpoints (MCF, SmartRecruiters, Workday), then plain HTML, then
 * (Singapore internships only, within Firecrawl caps) one markdown scrape.
 */
export async function fillDescriptions(sql: Sql, today: string, limit = 25): Promise<{ filled: number; unavailable: number; credits: number }> {
  const started = Date.now();
  const jobs = await repo.jobsNeedingJd(sql, limit);
  let filled = 0;
  let unavailable = 0;
  let credits = 0;
  for (const j of jobs) {
    const plan = detailPlan(j);
    const r = await httpGet(plan.url, plan.headers, 15_000);
    let text = r.status === 200 ? plan.parse(r.text) : '';
    if (text.length < 300 && env.firecrawlKey()) {
      const job = await repo.getJob(sql, j.id);
      if (job?.track === 'sg') {
        const fc = await scrape(sql, j.url, today);
        credits += fc.credits;
        if (fc.state === 'ok') text = htmlToText(fc.markdown);
      }
    }
    await repo.setJd(sql, j.id, text);
    if (text.trim().length >= 300) filled++;
    else unavailable++;
  }
  await repo.recordRun(sql, { step: 'describe', seconds: (Date.now() - started) / 1000, ok: true, credits, detail: { filled, unavailable } });
  return { filled, unavailable, credits };
}
