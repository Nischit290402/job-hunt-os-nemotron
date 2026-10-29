/**
 * The Companies view: query parsing and status labels. Pure; the queries live in server/companies.ts.
 */
import type { AppState } from './state';

export const COMPANY_SORTS = ['score', 'jobs', 'recent', 'name'] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];
export const VIEW_TYPES = ['', 'intern', 'parttime', 'fulltime'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export interface CompanyQuery {
  q: string;
  type: ViewType;
  sort: CompanySort;
  offset: number;
  limit: number;
}

const int = (v: string | null, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Reads ?q=&type=&sort=&offset=&limit= safely; anything unknown falls back to the default. */
export function parseCompanyQuery(p: URLSearchParams, defLimit = 15): CompanyQuery {
  const type = (p.get('type') ?? '') as ViewType;
  const sort = (p.get('sort') ?? 'score') as CompanySort;
  return {
    q: String(p.get('q') ?? '').replace(/[%_\\]/g, ' ').trim().slice(0, 60),
    type: VIEW_TYPES.includes(type) ? type : '',
    sort: COMPANY_SORTS.includes(sort) ? sort : 'score',
    offset: int(p.get('offset'), 0, 0, 100_000),
    limit: int(p.get('limit'), defLimit, 1, 50),
  };
}

export type Tone = 'good' | 'accent' | 'warn' | 'bad' | 'muted';

/** Where you stand on one job, in words: your application's stage, or whether it has been scored yet. */
export function jobStatus(state: AppState | string | null, scored: boolean): { label: string; tone: Tone } {
  switch (state) {
    case null:
    case undefined:
    case '':
      return scored ? { label: 'Not picked', tone: 'muted' } : { label: 'Scoring', tone: 'muted' };
    case 'today':
      return { label: 'In Today', tone: 'accent' };
    case 'snoozed':
      return { label: 'Snoozed', tone: 'muted' };
    case 'tailoring':
    case 'finding_contact':
    case 'awaiting_send':
      return { label: 'Preparing', tone: 'accent' };
    case 'ask_sent':
      return { label: 'Referral wait', tone: 'accent' };
    case 'ready_to_fill':
    case 'prefilled':
      return { label: 'Ready to submit', tone: 'warn' };
    case 'applied':
      return { label: 'Applied', tone: 'good' };
    case 'interview':
      return { label: 'Interview', tone: 'good' };
    case 'offer':
      return { label: 'Offer', tone: 'good' };
    case 'rejected':
      return { label: 'Rejected', tone: 'bad' };
    case 'withdrawn':
      return { label: 'Withdrawn', tone: 'muted' };
    case 'skipped':
      return { label: 'Skipped', tone: 'muted' };
    default:
      return { label: String(state).replace(/_/g, ' '), tone: 'muted' };
  }
}

export const TYPE_LABEL: Record<string, string> = { intern: 'Intern', parttime: 'Part-time', fulltime: 'Full-time' };
