/**
 * Source parsers. Each source type exposes the URLs to request and a pure parse() over the response body, so every
 * parser is unit-tested on fixtures and the network code lives in one adapter (src/server/collector.ts).
 *
 * Endpoints marked UNVERIFIED worked in v0.3.1 only as far as last_status shows; the first live run is the check.
 */
import { htmlToText } from '../html';
import { cleanTitle } from '../keys';
import { toSgtDate } from '../time';
import type { Channel, RawJob } from '../filters';

export type SourceType = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'mcf' | 'freehire' | 'mdlist' | 'crawl';

export interface SourceRow {
  id: string;
  type: SourceType;
  company: string;
  slug_or_url: string;
  link_pattern?: string | null;
  default_location?: string | null;
  track_hint?: string | null;
}

export interface Request {
  url: string;
  headers?: Record<string, string>;
  /** Free-form tag the parser receives back, e.g. the search phrase. */
  tag?: string;
}

const enc = encodeURIComponent;
const CHANNEL: Record<SourceType, Channel> = {
  greenhouse: 'ATS', lever: 'ATS', ashby: 'ATS', smartrecruiters: 'ATS', mcf: 'SGP', freehire: 'AGG', mdlist: 'LIST', crawl: 'CRAWL',
};
export const channelOf = (t: SourceType): Channel => CHANNEL[t];

const parseJson = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

export class ParseError extends Error {}

// ---------- Greenhouse (content=true returns the description, which v0.3.1 never stored) ----------
export const greenhouse = {
  requests: (s: SourceRow): Request[] => [{ url: `https://boards-api.greenhouse.io/v1/boards/${enc(s.slug_or_url)}/jobs?content=true` }],
  parse(body: string, s: SourceRow): RawJob[] {
    const data = parseJson(body);
    if (!data || !Array.isArray(data.jobs)) throw new ParseError('greenhouse bad json');
    return data.jobs.map((j: any) => ({
      company: s.company,
      title: j.title,
      location: j.location?.name || '',
      url: j.absolute_url,
      posted: toSgtDate(j.first_published || j.updated_at),
      channel: 'ATS' as const,
      jdText: j.content ? htmlToText(j.content) : '',
      atsName: 'greenhouse',
      atsJobId: String(j.id ?? ''),
    }));
  },
};

// ---------- Lever ----------
export const lever = {
  requests: (s: SourceRow): Request[] => [{ url: `https://api.lever.co/v0/postings/${enc(s.slug_or_url)}?mode=json` }],
  parse(body: string, s: SourceRow): RawJob[] {
    const data = parseJson(body);
    if (!Array.isArray(data)) throw new ParseError('lever bad json');
    return data.map((j: any) => {
      const c = j.categories || {};
      const locs = (c.allLocations?.length ? c.allLocations : [c.location || '']).join('; ');
      const lists = (j.lists || []).map((l: any) => `${l.text}\n${htmlToText(l.content || '')}`).join('\n');
      return {
        company: s.company,
        title: j.text,
        location: locs,
        url: j.hostedUrl,
        posted: toSgtDate(j.createdAt),
        channel: 'ATS' as const,
        remote: j.workplaceType === 'remote',
        jdText: [j.descriptionPlain || htmlToText(j.description || ''), lists, j.additionalPlain || ''].filter(Boolean).join('\n\n'),
        atsName: 'lever',
        atsJobId: String(j.id ?? ''),
      };
    });
  },
};

// ---------- Ashby ----------
export const ashby = {
  requests: (s: SourceRow): Request[] => [{ url: `https://api.ashbyhq.com/posting-api/job-board/${enc(s.slug_or_url)}` }],
  parse(body: string, s: SourceRow): RawJob[] {
    const data = parseJson(body);
    if (!data || !Array.isArray(data.jobs)) throw new ParseError('ashby bad json');
    return data.jobs
      .filter((j: any) => j.isListed !== false)
      .map((j: any) => {
        const locs = [j.location, ...(j.secondaryLocations || []).map((x: any) => x.location)].filter(Boolean).join('; ');
        return {
          company: s.company,
          title: j.title,
          location: locs,
          url: j.jobUrl || j.applyUrl,
          posted: toSgtDate(j.publishedAt),
          channel: 'ATS' as const,
          remote: j.workplaceType ? String(j.workplaceType).toLowerCase() === 'remote' : j.isRemote === true,
          jdText: j.descriptionPlain || htmlToText(j.descriptionHtml || ''),
          atsName: 'ashby',
          atsJobId: String(j.id ?? ''),
        };
      });
  },
};

// ---------- SmartRecruiters (UNVERIFIED; list has no description, detail fetched later for kept jobs) ----------
export const smartrecruiters = {
  requests: (s: SourceRow): Request[] =>
    [0, 100, 200].map((offset) => ({
      url: `https://api.smartrecruiters.com/v1/companies/${enc(s.slug_or_url)}/postings?limit=100&country=sg&offset=${offset}`,
    })),
  parse(body: string, s: SourceRow): RawJob[] {
    const data = parseJson(body);
    if (!data || !Array.isArray(data.content)) throw new ParseError('smartrecruiters bad json');
    return data.content.map((j: any) => {
      const l = j.location || {};
      return {
        company: s.company,
        title: j.name,
        location: l.fullLocation || [l.city, l.country].filter(Boolean).join(', '),
        url: `https://jobs.smartrecruiters.com/${s.slug_or_url}/${j.id}`,
        posted: toSgtDate(j.releasedDate),
        channel: 'ATS' as const,
        remote: l.remote === true,
        atsName: 'smartrecruiters',
        atsJobId: String(j.id ?? ''),
        detailRef: `https://api.smartrecruiters.com/v1/companies/${enc(s.slug_or_url)}/postings/${enc(String(j.id))}`,
      };
    });
  },
  parseDetail(body: string): string {
    const d = parseJson(body);
    const sec = d?.jobAd?.sections || {};
    return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
      .map((k) => (sec[k]?.text ? htmlToText(sec[k].text) : ''))
      .filter(Boolean)
      .join('\n\n');
  },
};

// ---------- MyCareersFuture (UNVERIFIED search parameter; filters still run client-side) ----------
export const MCF_QUERIES = [
  'machine learning intern', 'ai intern', 'computer vision', 'deep learning intern', 'data science intern',
  'research engineer intern', 'quantitative research intern',
];
export const mcf = {
  requests: (_s: SourceRow, queries: string[] = MCF_QUERIES): Request[] =>
    queries.map((q) => ({
      url: `https://api.mycareersfuture.gov.sg/v2/jobs?search=${enc(q)}&limit=100&page=0&sortBy=new_posting_date`,
      headers: { Accept: 'application/json' },
      tag: q,
    })),
  parse(body: string): RawJob[] {
    const data = parseJson(body);
    if (!data || !Array.isArray(data.results)) throw new ParseError('mcf bad json');
    return data.results.map((r: any) => {
      const meta = r.metadata || {};
      const company = r.postedCompany?.name || r.hiringCompany?.name || '';
      return {
        company,
        title: r.title,
        location: 'Singapore',
        url: meta.jobDetailsUrl || `https://www.mycareersfuture.gov.sg/job/${r.uuid || ''}`,
        posted: toSgtDate(meta.newPostingDate || meta.createdAt),
        channel: 'SGP' as const,
        intern: /intern|attachment/i.test(JSON.stringify(r.employmentTypes || [])),
        jdText: r.description ? htmlToText(r.description) : '',
        atsName: r.uuid ? 'mcf' : undefined,
        atsJobId: r.uuid || undefined,
        detailRef: r.uuid ? `https://api.mycareersfuture.gov.sg/v2/jobs/${enc(r.uuid)}` : undefined,
      };
    });
  },
  parseDetail(body: string): string {
    const d = parseJson(body);
    return d?.description ? htmlToText(d.description) : '';
  },
};

// ---------- freehire.me (UNVERIFIED from this workspace; best effort) ----------
export const FREEHIRE_QUERIES = [
  'machine learning intern', 'ai intern', 'computer vision intern', 'quantitative research intern', 'research engineer intern',
  'applied scientist intern',
];
export const freehire = {
  requests: (_s: SourceRow, queries: string[] = FREEHIRE_QUERIES): Request[] =>
    queries.flatMap((q) =>
      ['countries=SG', 'work_mode=remote'].map((facet) => ({
        url:
          `https://freehire.me/api/v1/agent/jobs/search?q=${enc(q)}&${facet}` +
          '&limit=30&offset=0&semantic_ratio=0&include_description=true&posted_within_days=45',
        headers: { Accept: 'application/json' },
        tag: `${q} ${facet}`,
      }))
    ),
  parse(body: string): RawJob[] {
    const data = parseJson(body);
    if (!data || !Array.isArray(data.data)) throw new ParseError('freehire bad json');
    return data.data
      .filter((j: any) => j.url)
      .map((j: any) => {
        const inSg = (j.countries || []).includes('SG');
        let loc = j.location || '';
        if (inSg && !/singapore/i.test(loc)) loc = loc ? `${loc}; Singapore` : 'Singapore';
        return {
          company: j.company || '',
          title: j.title,
          location: loc,
          url: j.url,
          posted: toSgtDate(j.posted_at),
          channel: 'AGG' as const,
          remote: j.work_mode === 'remote',
          jdText: j.description ? htmlToText(j.description) : '',
        };
      });
  },
};

// ---------- Markdown list (speedyapply INTERN_INTL.md) ----------
function cellText(c: string): string {
  return cleanTitle(String(c || '').replace(/<br\s*\/?>/gi, '; ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*+/g, ''));
}
function cellUrl(c: string): string {
  const s = String(c || '');
  const m = s.match(/href=["']([^"']+)["']/i) || s.match(/\]\((https?:\/\/[^)\s]+)\)/) || s.match(/(https?:\/\/[^\s<>)"']+)/);
  return m ? m[1] : '';
}
export const mdlist = {
  requests: (s: SourceRow): Request[] => [{ url: s.slug_or_url }],
  /** Company | Position | Location | Posting | Age. A "↳" company cell repeats the row above. */
  parse(body: string, _s: SourceRow, now: number = Date.now()): RawJob[] {
    const jobs: RawJob[] = [];
    let lastCompany = '';
    for (const raw of String(body).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('|')) continue;
      const cells = line.replace(/^\||\|$/g, '').split('|');
      if (cells.length < 4 || cells.every((c) => /^[\s:-]*$/.test(c))) continue;
      let company = cellText(cells[0]);
      if (/^company$/i.test(company)) continue;
      if (!company || company === '↳') company = lastCompany;
      else lastCompany = company;
      const url = cellUrl(cells[3]);
      if (!url) continue;
      const age = String(cells[4] || '').match(/(\d+)\s*d/i);
      jobs.push({
        company,
        title: cellText(cells[1]),
        location: cellText(cells[2]),
        url,
        posted: age ? toSgtDate(now - Number(age[1]) * 86_400_000) : '',
        channel: 'LIST',
      });
    }
    return jobs;
  },
};

// ---------- Job description lookups for postings that arrive without one ----------

/**
 * Workday career sites render with JavaScript, but every tenant serves the same posting as JSON under /wday/cxs/.
 * https://razer.wd3.myworkdayjobs.com/en-US/careers/job/SG/RL-Intern_JR1  ->  https://razer.wd3.myworkdayjobs.com/wday/cxs/razer/careers/job/SG/RL-Intern_JR1
 */
export function workdayCxsUrl(url: string): string {
  const m = String(url).match(/^https:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/([^?#]+)/);
  if (!m) return '';
  const [, tenant, wd, site, path] = m;
  return `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${path}`;
}

export function parseWorkdayDetail(body: string): string {
  const d = parseJson(body);
  const info = d?.jobPostingInfo;
  if (!info) return '';
  return [info.title, info.location, info.timeType, info.jobDescription ? htmlToText(info.jobDescription) : ''].filter(Boolean).join('\n');
}

export type DetailPlan = { url: string; headers?: Record<string, string>; parse: (body: string) => string; kind: string };

/** How to get the description for a job that has none: API detail endpoints first, plain HTML as the fallback. */
export function detailPlan(job: { url: string; detail_ref: string | null }): DetailPlan {
  if (job.detail_ref?.includes('api.mycareersfuture.gov.sg')) return { url: job.detail_ref, headers: { Accept: 'application/json' }, parse: mcf.parseDetail, kind: 'mcf' };
  if (job.detail_ref?.includes('api.smartrecruiters.com')) return { url: job.detail_ref, parse: smartrecruiters.parseDetail, kind: 'smartrecruiters' };
  const wd = workdayCxsUrl(job.url);
  if (wd) return { url: wd, headers: { Accept: 'application/json' }, parse: parseWorkdayDetail, kind: 'workday' };
  return { url: job.url, parse: htmlToText, kind: 'html' };
}

// ---------- Crawl (Firecrawl markdown of a careers page; link_pattern = "<url regex>" or "<regex>||<prefix to strip>") ----------
export const crawl = {
  parse(markdown: string, s: SourceRow): RawJob[] {
    const [pattern = '', strip = ''] = String(s.link_pattern || '').split('||');
    const re = pattern ? new RegExp(pattern) : null;
    const origin = (String(s.slug_or_url).match(/^https?:\/\/[^/]+/) || [''])[0];
    const seen = new Set<string>();
    const jobs: RawJob[] = [];
    const linkRe = /\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(markdown)) !== null) {
      let url = m[2];
      if (url.startsWith('/')) url = origin + url;
      if (!/^https?:\/\//.test(url) || (re && !re.test(url))) continue;
      let title = cleanTitle(m[1].replace(/!\[[^\]]*\]\([^)]*\)/g, ''));
      if (strip && title.startsWith(strip)) title = title.slice(strip.length);
      title = title.trim();
      if (!title || seen.has(url)) continue;
      seen.add(url);
      jobs.push({ company: s.company, title, location: s.default_location || '', url, posted: '', channel: 'CRAWL' });
    }
    return jobs;
  },
  /** Firecrawl pages after the first: Google careers uses ?page=N. Returns '' when the site has no known pagination. */
  pageUrl(url: string, page: number): string {
    if (page <= 1) return url;
    if (/google\.com\/about\/careers/.test(url)) return `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
    return '';
  },
};
