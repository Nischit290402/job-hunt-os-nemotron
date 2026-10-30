/**
 * /search <company>: find a company's open roles on demand. Pure helpers: queries, reading search results as
 * postings, and the Telegram report. The fetching lives in server/companySearch.ts.
 */
import { searchName } from './contacts';
import { cleanTitle } from './keys';
import { TYPE_LABEL } from './companies';

const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|workable\.com|recruitee\.com|teamtailor\.com|bamboohr\.com|icims\.com|successfactors\.(com|eu)|taleo\.net|oraclecloud\.com|jobvite\.com|breezy\.hr|zohorecruit\.com)$/i;
const AGGREGATOR = /(^|\.)(linkedin\.com|glassdoor\.[a-z.]+|indeed\.[a-z.]+|jobstreet\.[a-z.]+|jobsdb\.[a-z.]+|mycareersfuture\.gov\.sg|builtin[a-z]*\.com|ziprecruiter\.com|simplyhired\.[a-z.]+|talent\.com|jooble\.org|careerjet\.[a-z.]+|nodeflair\.com|efinancialcareers\.[a-z.]+|wellfound\.com|prosple\.com|himalayas\.app|freehire\.me|reddit\.com|youtube\.com|facebook\.com|x\.com|twitter\.com|instagram\.com)$/i;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function searchQueries(company: string): string[] {
  const n = searchName(company);
  return [
    `"${n}" (intern OR internship OR "part-time") Singapore (site:greenhouse.io OR site:lever.co OR site:ashbyhq.com OR site:myworkdayjobs.com OR site:smartrecruiters.com OR site:workable.com)`,
    `"${n}" careers Singapore intern OR internship OR engineer OR scientist jobs`,
  ];
}

/** "Job Application for ML Intern at Acme" / "ML Intern - Acme Careers" / "Acme - ML Intern | Lever" -> "ML Intern". */
export function postingTitle(raw: string, company: string): string {
  const name = searchName(company);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = cleanTitle(raw)
    .replace(/^job application for\s+/i, '')
    .replace(new RegExp(`\\s+at\\s+${esc}.*$`, 'i'), '')
    .replace(/\s*[|–—-]\s*(careers?|jobs?|lever|greenhouse|ashby|workday|smartrecruiters|workable)\b.*$/i, '')
    .replace(new RegExp(`\\s*[|–—-]\\s*${esc}( careers| jobs)?\\s*$`, 'i'), '')
    .replace(new RegExp(`^${esc}( careers| jobs)?\\s*[|–—:-]\\s*`, 'i'), '')
    .trim();
  t = t.replace(/\s*[|–—-]\s*$/, '').trim();
  return t.length >= 4 && t.length <= 150 ? t : '';
}

export interface FoundPosting {
  title: string;
  url: string;
  location: string;
  ats: boolean;
}

/**
 * A search result that is one posting of this company: a hiring-system page that names the company, or a page on the
 * company's own site whose path looks like a single job (an id or a long slug under careers/jobs). Search, list and
 * aggregator pages are ignored. Location comes from the result text: Singapore, remote, or unknown ('').
 */
export function postingFromResult(r: { url: string; title: string; description?: string }, company: string): FoundPosting | null {
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (AGGREGATOR.test(host)) return null;
  const co = slug(searchName(company));
  if (co.length < 2) return null;
  const path = `${u.pathname}${u.search}`.toLowerCase();
  const text = `${r.title} ${r.description ?? ''} ${path}`;
  const ats = ATS_HOST.test(host);
  if (ats) {
    if (!slug(`${host}${path}${r.title}`).includes(co.slice(0, Math.max(4, Math.min(co.length, 8))))) return null;
  } else {
    if (!slug(host).includes(co)) return null; // the company's own domain only
    if (!/career|job|position|opening|vacanc|apply|join|hiring|recruit/.test(`${host}${path}`)) return null;
  }
  // One posting, not a search or list page.
  const looksLikeOne = /\d{4,}|[?&](gh_jid|jobid|job_id|id)=|\/(jobs?|positions?|openings?|careers?)\/[^/?#]*-[^/?#]*-[^/?#]+/.test(path);
  const listPage = /\/(search|results)\/?(\?|$)|[?&](q|query|keywords?)=/.test(path) && !/\d{6,}/.test(path);
  if (!looksLikeOne || listPage) return null;
  const title = postingTitle(r.title, company);
  if (!title) return null;
  const location = /singapore/i.test(text) ? 'Singapore' : /\bremote\b|work from home|anywhere/i.test(text) ? 'Remote' : '';
  return { title, url: r.url, location, ats };
}

export const REJECT_LABEL: Record<string, string> = {
  senior_title: 'senior or lead',
  excluded_role: 'excluded roles (sales, ops, support...)',
  location: 'outside Singapore and not remote',
  wrong_year: 'wrong intake year',
  phd_only: 'PhD only',
  stale: 'old postings',
  not_program: 'remote but not an internship',
  not_ai_scope: 'outside your role scope',
  sg_not_intern_not_ft: 'not intern, part-time or full-time',
  empty_title: 'no title',
};

export interface SearchReport {
  company: string;
  checked: string[]; // where it looked, in words
  listed: number; // postings seen before filtering
  kept: number;
  newJobs: number;
  rejected: Record<string, number>;
  added: { jobId: number; title: string; type: string; isNew: boolean }[];
  notes: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The Telegram message for a finished search. */
export function searchReportText(r: SearchReport, appUrl: string, judging: number): string {
  const lines = [`<b>Search: ${esc(r.company)}</b>`, `Looked at: ${esc(r.checked.join('; ') || 'nothing available')}.`];
  if (!r.listed) {
    lines.push('No open postings found. If you saw one, send a screenshot of it or use /lead.');
  } else {
    lines.push(`${r.listed} posting${r.listed === 1 ? '' : 's'} seen; ${r.kept} fit (${r.newJobs} new, ${r.kept - r.newJobs} already in your list).`);
    const skipped = Object.entries(r.rejected).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (skipped.length) lines.push(`Skipped: ${skipped.map(([k, n]) => `${n} ${REJECT_LABEL[k] ?? k.replace(/_/g, ' ')}`).join(', ')}.`);
  }
  const shown = [...r.added].sort((a, b) => Number(b.isNew) - Number(a.isNew)).slice(0, 15);
  if (shown.length) {
    lines.push('');
    for (const a of shown) lines.push(`${a.isNew ? 'new' : 'known'} · ${esc(a.title)} (${TYPE_LABEL[a.type] ?? a.type})`);
    if (r.added.length > shown.length) lines.push(`and ${r.added.length - shown.length} more`);
  }
  for (const n of r.notes) lines.push(esc(n));
  if (r.kept) {
    lines.push('');
    lines.push(
      `${judging ? `Scoring ${judging} job${judging === 1 ? '' : 's'} now. ` : ''}Then /more adds the best to Today, or browse them: ${appUrl}/companies?q=${encodeURIComponent(searchName(r.company))}`
    );
  }
  return lines.join('\n').slice(0, 4000);
}
