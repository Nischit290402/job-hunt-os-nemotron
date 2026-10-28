/**
 * Keep / reject / archive decisions for one normalised job, ported from v0.3.1 Filters.gs.
 * Pure: no network, no database. `now` is injectable for tests.
 */
import { cleanTitle } from './keys';
import type { TermLists } from './terms';

export type Channel = 'ATS' | 'CRAWL' | 'LIST' | 'SGP' | 'AGG' | 'LEAD';
export type Track = 'sg' | 'remote' | 'ft' | 'archive';

export interface RawJob {
  company: string;
  title: string;
  location: string;
  url: string;
  posted: string; // 'YYYY-MM-DD' or ''
  channel: Channel;
  remote?: boolean;
  intern?: boolean;
  extra?: string;
  hint?: string; // 'remote' for hand-picked programme sources
  jdText?: string;
  atsName?: string;
  atsJobId?: string;
  detailRef?: string; // what the adapter needs to fetch the description later (e.g. an MCF uuid)
}

export type Decision =
  | { action: 'reject'; reason: string }
  | { action: 'keep'; track: Track; family: string; startWindow: string; hoursFlag: string; eligFlag: string };

export interface Rules {
  exclude: RegExp | null;
  senior: RegExp | null;
  archive: RegExp | null;
  intern: RegExp | null;
  role: RegExp | null;
  ft: RegExp | null;
  program: RegExp | null;
  eligTitle: RegExp | null;
  eligCompany: RegExp | null;
  maxAgeDays: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-boundary alternation. Multi-word terms match with a space or hyphen between the words. */
export function termsRegex(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  const alt = terms.map((t) => esc(t).replace(/\s+/g, '[\\s-]+')).join('|');
  return new RegExp(`(^|[^a-z0-9])(${alt})(?![a-z0-9])`, 'i');
}

export function buildRules(t: TermLists): Rules {
  return {
    exclude: termsRegex(t.exclude),
    senior: termsRegex(t.senior),
    archive: termsRegex(t.archive),
    intern: termsRegex(t.intern),
    role: termsRegex(t.role),
    ft: termsRegex(t.ft),
    program: termsRegex(t.program),
    eligTitle: termsRegex(t.eligTitle),
    eligCompany: termsRegex(t.eligCompany),
    maxAgeDays: t.maxAgeDays,
  };
}

export function isPhdOnly(title: string): boolean {
  const phd = /(^|[^a-z])(ph\.?\s?d|doctoral|doctorate)([^a-z]|$)/i.test(title);
  const ms = /(^|[^a-z])(ms|m\.s\.|msc|m\.sc|master|masters|master's)([^a-z]|$)/i.test(title);
  return phd && !ms;
}

const CHANNEL_RANK: Record<Channel, number> = { ATS: 1, CRAWL: 2, LIST: 3, SGP: 4, AGG: 5, LEAD: 6 };
/** Lower is more trusted. When two channels report the same job, the more trusted apply link wins. */
export const channelRank = (c: Channel) => CHANNEL_RANK[c] ?? 9;

export function familyOf(title: string): string {
  if (/quant|trader|trading/i.test(title)) return 'quant';
  if (/vision|perception|image|video|robotic/i.test(title)) return 'cv';
  if (/nlp|language|llm|generative|genai|agent|speech/i.test(title)) return 'llm/nlp';
  if (/research/i.test(title)) return 'research';
  return 'ml';
}

export function startWindow(text: string): string {
  const t = String(text || '');
  if (/summer/i.test(t)) return 'Summer';
  if (/off[\s-]?cycle|winter|spring|(^|[^a-z])jan(uary)?([^a-z]|$)|(^|[^a-z])h1([^a-z]|$)|first half/i.test(t)) return 'Jan (shiftable)';
  if (/fall|autumn/i.test(t)) return 'Fall';
  return '';
}

export function evaluateJob(job: RawJob, R: Rules, now: number = Date.now()): Decision {
  const title = cleanTitle(job.title);
  const loc = String(job.location || '');
  const rej = (reason: string): Decision => ({ action: 'reject', reason });
  if (!title) return rej('empty_title');

  if (R.maxAgeDays && /^\d{4}-\d{2}-\d{2}/.test(job.posted || '')) {
    const ageDays = (now - Date.parse(job.posted.slice(0, 10) + 'T00:00:00Z')) / 86_400_000;
    if (ageDays > R.maxAgeDays) return rej('stale');
  }

  const forExclude = title.replace(/operations research/gi, 'OR');
  if (R.exclude?.test(forExclude)) return rej('excluded_role');
  if (R.senior?.test(title)) return rej('senior_title');
  if (isPhdOnly(title)) return rej('phd_only');

  const isIntern = !!R.intern?.test(title) || job.intern === true;

  const years = (title.match(/20\d\d/g) || []).map(Number);
  if (years.length) {
    const has27 = years.includes(2027);
    const has28 = years.includes(2028);
    if (isIntern && !has27) return rej('wrong_year');
    if (!isIntern && !has27 && !has28) return rej('wrong_year');
  }

  // Hand-picked programme sources (hint=remote) may carry no AI term in the title.
  const curated = job.hint === 'remote';
  if (!curated && !R.role?.test(title)) return rej('not_ai_scope');

  const isSG = /singapore/i.test(`${loc} ${title}`) || /(^|[^a-z])sg([^a-z]|$)/i.test(loc);
  const remoteText = /remote|work from home|wfh|anywhere|distributed|worldwide|global/i.test(`${loc} ${title}`);
  const remote = job.remote === true || job.hint === 'remote' || remoteText;
  if (!isSG && !remote) return rej('location');

  const family = familyOf(title);
  const sw = startWindow(`${title} ${job.extra || ''}`);
  const elig = R.eligTitle?.test(title) || R.eligCompany?.test(String(job.company || '')) ? 'VERIFY eligibility' : '';
  const keep = (track: Track, hours: string): Decision => ({
    action: 'keep',
    track,
    family,
    startWindow: sw,
    hoursFlag: hours,
    eligFlag: elig,
  });

  if (R.archive?.test(title)) return keep('archive', '');
  if (isSG) {
    if (isIntern) return keep('sg', '');
    if (R.ft?.test(title)) return keep('ft', '');
    return rej('sg_not_intern_not_ft');
  }
  if (isIntern || R.program?.test(title)) {
    const apiOnly = job.remote === true && job.hint !== 'remote' && !remoteText;
    return keep('remote', apiOnly ? 'VERIFY <=16h/wk; VERIFY remote' : 'VERIFY <=16h/wk');
  }
  return rej('not_program');
}
