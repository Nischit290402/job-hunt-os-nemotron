/**
 * Apply routes for jobs found on MyCareersFuture or aggregators, where you cannot apply (MyCareersFuture needs Singpass)
 * or the page is only a copy. Preference: the employer's hiring-system page (Greenhouse, Lever, Ashby, Workday,
 * SmartRecruiters; often live before the careers site), then the company's own careers site, then an "email your CV"
 * address in the description. With none of those the job is hidden: not worth applying without an official route.
 */
import { normTitle } from './keys';
import { searchName } from './contacts';

export type RouteKind = 'official' | 'email' | 'none';

export const ROUTE_CHANNELS = ['SGP', 'AGG'];

const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|workable\.com|recruitee\.com|bamboohr\.com|teamtailor\.com|personio\.(de|com)|icims\.com|successfactors\.(com|eu)|taleo\.net|oraclecloud\.com|jobvite\.com|breezy\.hr|zohorecruit\.com)$/i;
const NOT_OFFICIAL = /(^|\.)(linkedin\.com|glassdoor\.[a-z.]+|indeed\.[a-z.]+|jobstreet\.[a-z.]+|jobsdb\.[a-z.]+|mycareersfuture\.gov\.sg|freehire\.me|builtin[a-z]*\.com|himalayas\.app|prosple\.com|workopia\.io|ziprecruiter\.com|simplyhired\.[a-z.]+|talent\.com|jooble\.org|careerjet\.[a-z.]+|nodeflair\.com|efinancialcareers\.[a-z.]+|wellfound\.com|ycombinator\.com|google\.com|facebook\.com|x\.com|twitter\.com|reddit\.com|youtube\.com|instagram\.com|tiktok\.com)$/i;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Queries for the employer's own posting, hiring systems first. */
export function routeQueries(company: string, title: string): string[] {
  const name = searchName(company);
  const t = title.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
  return [
    `"${name}" "${t}" (site:greenhouse.io OR site:lever.co OR site:ashbyhq.com OR site:myworkdayjobs.com OR site:smartrecruiters.com)`,
    `"${name}" ${t} careers apply`,
  ];
}

/** Share of the job title's words present in the result title (1 = all). */
export function titleOverlap(jobTitle: string, resultTitle: string): number {
  const want = normTitle(jobTitle).split(' ').filter((w) => w.length > 2 && !['and', 'the', 'for', 'with'].includes(w));
  if (!want.length) return 0;
  const have = new Set(normTitle(resultTitle).split(' '));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** 'ats' for a hiring-system page of this company, 'careers' for the company's own site, else null. */
export function classifyResult(r: { url: string; title: string }, company: string, jobTitle: string): 'ats' | 'ats-check' | 'careers' | null {
  let host = '';
  let path = '';
  try {
    const u = new URL(r.url);
    host = u.hostname.toLowerCase();
    path = `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return null;
  }
  if (NOT_OFFICIAL.test(host)) return null;
  const co = slug(searchName(company));
  const coShort = co.slice(0, Math.max(5, Math.min(co.length, 8)));
  const mentions = slug(`${host}${path}${r.title}`).includes(coShort);
  // Search engines often show hiring-system pages as "Back to jobs" or "Job Application": check the page itself then.
  if (ATS_HOST.test(host) && mentions && titleOverlap(jobTitle, r.title) < 0.6) return 'ats-check';
  if (titleOverlap(jobTitle, r.title) < 0.6) return null;
  if (ATS_HOST.test(host)) return mentions ? 'ats' : null;
  const hostHasCompany = slug(host).includes(coShort);
  if (hostHasCompany && /career|job|position|opening|vacanc|apply|join|hiring|recruit/.test(`${host}${path}`)) return 'careers';
  return null;
}

/**
 * Best official link among search results: a hiring-system page first, then the careers site. `confirm` checks a
 * hiring-system page whose search title says nothing ("Back to jobs") by reading the page itself.
 */
export async function pickRoute(
  results: { url: string; title: string }[],
  company: string,
  jobTitle: string,
  confirm: (url: string) => Promise<boolean> = async () => false
): Promise<string | null> {
  let careers: string | null = null;
  for (const r of results) {
    const k = classifyResult(r, company, jobTitle);
    if (k === 'ats') return r.url;
    if (k === 'ats-check' && (await confirm(r.url))) return r.url;
    if (k === 'careers' && !careers) careers = r.url;
  }
  return careers;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NOT_APPLY_MAILBOX = /^(no-?reply|donotreply|privacy|dpo|dataprotection|data\.protection|pdpa|compliance|legal|support|info@mycareersfuture)/i;

/** An address the posting asks you to send your CV or application to, or null. */
export function extractApplyEmail(jd: string): string | null {
  const text = String(jd || '');
  for (const m of text.matchAll(EMAIL)) {
    const email = m[0].replace(/[.,;:)]+$/, '');
    if (NOT_APPLY_MAILBOX.test(email)) continue;
    const around = text.slice(Math.max(0, (m.index ?? 0) - 160), (m.index ?? 0) + email.length + 60).toLowerCase();
    if (/\b(cv|resume|résumé|apply|application|applications|send|email|submit|interested)\b/.test(around)) return email;
  }
  return null;
}

// ---------- public job-board APIs (exact, no search quota) ----------

export interface Posting {
  title: string;
  url: string;
  location: string;
}

/** Board names to try for a company: "MOTIONAL SINGAPORE PTE. LIMITED" -> motional; "Hudson River Trading" -> hudsonrivertrading, hudson-river-trading. */
export function boardSlugs(company: string): string[] {
  const name = searchName(company).toLowerCase();
  const joined = name.replace(/[^a-z0-9]+/g, '');
  const dashed = name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([joined, dashed].filter((x) => x.length >= 2))].slice(0, 2);
}

export const BOARD_APIS: { name: string; url: (slug: string) => string; parse: (body: string, slug: string) => Posting[] }[] = [
  {
    name: 'greenhouse',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
    // The hosted Greenhouse form, not absolute_url: company pages often wrap the form in an iframe the agent cannot reach.
    parse: (b, slug) =>
      ((JSON.parse(b).jobs ?? []) as any[]).map((j) => ({
        title: String(j.title ?? ''),
        url: j.id ? greenhouseFormUrl(slug, String(j.id)) : String(j.absolute_url ?? ''),
        location: String(j.location?.name ?? ''),
      })),
  },
  {
    name: 'lever',
    url: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
    parse: (b) => ((JSON.parse(b) ?? []) as any[]).map((j) => ({ title: String(j.text ?? ''), url: String(j.hostedUrl ?? ''), location: String(j.categories?.location ?? '') })),
  },
  {
    name: 'ashby',
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
    parse: (b) => ((JSON.parse(b).jobs ?? []) as any[]).map((j) => ({ title: String(j.title ?? ''), url: String(j.jobUrl ?? ''), location: String(j.location ?? '') })),
  },
];

/** The posting on a company board that is this job: close title match, Singapore preferred. */
export function bestPosting(postings: Posting[], jobTitle: string): Posting | null {
  const scored = postings
    .filter((p) => /^https?:\/\//.test(p.url))
    .map((p) => ({ p, s: Math.min(titleOverlap(jobTitle, p.title), titleOverlap(p.title, jobTitle)), sg: /singapore/i.test(p.location) }))
    .filter((x) => x.s >= 0.75)
    .sort((a, b) => Number(b.sg) - Number(a.sg) || b.s - a.s);
  return scored[0]?.p ?? null;
}

/**
 * Greenhouse's standalone application form. Company careers pages that show Greenhouse jobs (gh_jid=...) often render
 * their own app with the form behind clicks or an iframe; this URL is the form itself, whatever the company redirects.
 */
export function greenhouseFormUrl(board: string, jobId: string): string {
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(jobId)}`;
}

/** The form URL for a Greenhouse job, given its board, when `url` is a gh_jid page or a hosted job page; else null. */
export function greenhouseFormFor(url: string, board: string | null): string | null {
  const m = url.match(/[?&]gh_jid=(\d+)/) || url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (!m) return null;
  if (m.length === 3) return greenhouseFormUrl(m[1], m[2]);
  return board ? greenhouseFormUrl(board, m[1]) : null;
}
