/**
 * Picks the Today list. Plain code, not a model, so you can read why one job beat another.
 *
 *   priority = score + deadline bonus (0..15) + new-posting bonus (0..5) - 20 if an application at that employer is active
 *   excluded: Skip verdict, score below minScore, deadline passed, FT_Watch/Archive track, employer cap used up,
 *             jobs already decided, jobs snoozed until a later day
 *   Today = top N by priority, at most one per employer.
 *
 * The v0.3.1 age bonus is gone: it pushed old, ignored rows to the top.
 */
import { DEFAULT_JOB_TYPES, jobTypeOf, type JobType } from './filters';
import { daysBetween, isIsoDate } from './time';

export interface Candidate {
  jobId: number;
  companyKey: string;
  company: string;
  title: string;
  track: 'sg' | 'remote' | 'ft' | 'archive';
  hoursFlag?: string | null;
  /** 'none': only on MyCareersFuture or an aggregator, with no official page or apply email. Hidden. */
  applyRoute?: 'official' | 'email' | 'none' | null;
  score: number;
  verdict: 'Apply now' | 'Apply this week' | 'Watch' | 'Skip';
  deadline: string; // 'YYYY-MM-DD' | 'rolling' | ''
  posted: string; // 'YYYY-MM-DD' | ''
  firstSeen: string; // 'YYYY-MM-DD'
  /** Existing application for this job, if any. */
  appState?: string | null;
  snoozeUntil?: string | null;
}

export interface EmployerInfo {
  /** Applications at this employer in an active state (tailoring .. interview). */
  active: number;
  /** Applications at this employer that count against a cap (applied or later, plus in-flight). */
  used: number;
  /** Max applications allowed, e.g. TikTok's 2 for the 2027-start project. null = no cap. */
  cap: number | null;
}

export interface RankOptions {
  today: string;
  max?: number;
  minScore?: number;
  /** Job types that may reach Today. Default: internships and part-time. */
  jobTypes?: JobType[];
}

export interface Ranked extends Candidate {
  priority: number;
  why: string[];
}

export function deadlineBonus(deadline: string, today: string): number | null {
  if (!isIsoDate(deadline)) return 0;
  const left = daysBetween(today, deadline);
  if (left < 0) return null; // passed
  if (left <= 3) return 15;
  if (left <= 7) return 12;
  if (left <= 14) return 8;
  if (left <= 30) return 4;
  return 0;
}

export function freshBonus(posted: string, firstSeen: string, today: string): number {
  const ref = isIsoDate(posted) ? posted : firstSeen;
  if (!isIsoDate(ref)) return 0;
  const age = daysBetween(ref, today);
  if (age <= 3) return 5;
  if (age <= 7) return 3;
  return 0;
}

export function scoreCandidate(c: Candidate, emp: EmployerInfo | undefined, opts: RankOptions): Ranked | null {
  const minScore = opts.minScore ?? 55;
  if (c.track === 'archive' || c.applyRoute === 'none') return null;
  if (!(opts.jobTypes ?? DEFAULT_JOB_TYPES).includes(jobTypeOf(c.track, c.hoursFlag))) return null;
  if (c.verdict === 'Skip' || c.score < minScore) return null;
  if (c.appState && !(c.appState === 'snoozed' && c.snoozeUntil && c.snoozeUntil <= opts.today) && c.appState !== 'today') {
    return null;
  }
  if (emp?.cap != null && emp.used >= emp.cap) return null;
  const dl = deadlineBonus(c.deadline, opts.today);
  if (dl === null) return null;
  const fresh = freshBonus(c.posted, c.firstSeen, opts.today);
  const penalty = emp && emp.active > 0 ? 20 : 0;
  const why = [`score ${c.score}`];
  if (dl) why.push(`deadline +${dl}`);
  if (fresh) why.push(`new +${fresh}`);
  if (penalty) why.push(`active application at ${c.company} -20`);
  return { ...c, priority: c.score + dl + fresh - penalty, why };
}

export function pickToday(cands: Candidate[], employers: Map<string, EmployerInfo>, opts: RankOptions): Ranked[] {
  const max = opts.max ?? 3;
  const ranked = cands
    .map((c) => scoreCandidate(c, employers.get(c.companyKey), opts))
    .filter((r): r is Ranked => r !== null)
    .sort((a, b) => b.priority - a.priority || b.score - a.score || a.jobId - b.jobId);
  const out: Ranked[] = [];
  const usedEmployers = new Set<string>();
  for (const r of ranked) {
    if (usedEmployers.has(r.companyKey)) continue;
    usedEmployers.add(r.companyKey);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}
