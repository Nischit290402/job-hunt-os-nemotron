/**
 * Deterministic intake rules, applied before the router. Pure: no network, no model.
 * R1 screenshot lead, R3 LinkedIn-only link (reply, no fetch), R2 other link, R4 pasted job description, R0 router decides.
 */
import type { ChatRequest } from '../agents/types';
import { isLinkedInUrl } from './lead';

export type IntakeRule = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export interface Intake {
  rule: IntakeRule;
  urls: string[]; // non-LinkedIn http(s) URLs
  linkedinUrls: string[];
  hasImages: boolean;
  looksLikeJd: boolean;
}

export const LINKEDIN_REPLY = 'I never open LinkedIn links. Send a screenshot of the post, or paste its text, and I will take it from there.';

const JD_MIN_CHARS = 400;
const JD_WORDS = [
  /\bresponsibilit/i,
  /\brequirements?\b/i,
  /\bqualifications?\b/i,
  /\bapply\b/i,
  /\bintern(ship)?s?\b/i,
  /\brole\b/i,
  /\bexperience\b/i,
  /\bskills?\b/i,
  /\bwhat you('|’)?ll do\b/i,
  /\byou will\b/i,
  /\bjob description\b/i,
  /\bbenefits\b/i,
];

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// LinkedIn written without a scheme still counts as LinkedIn, so it gets the screenshot reply rather than a fetch.
const BARE_LINKEDIN_RE = /(?<![\w./-])(?:[a-z0-9-]+\.)*(?:linkedin\.com|lnkd\.in)\/[^\s<>"'`]*/gi;

const trimUrl = (u: string) => u.replace(/[.,;:!?)\]}>'"]+$/, '');

export function isLinkedInLike(u: string): boolean {
  if (isLinkedInUrl(u)) return true;
  return /^https?:\/\/([a-z0-9-]+\.)*lnkd\.in(\/|$)/i.test(u.trim());
}

export function findUrls(text: string): { urls: string[]; linkedinUrls: string[] } {
  const s = String(text ?? '');
  const urls: string[] = [];
  const linkedin: string[] = [];
  for (const m of s.match(URL_RE) ?? []) {
    const u = trimUrl(m);
    if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(u)) continue;
    (isLinkedInLike(u) ? linkedin : urls).push(u);
  }
  const noSchemes = s.replace(URL_RE, ' ');
  for (const m of noSchemes.match(BARE_LINKEDIN_RE) ?? []) linkedin.push(`https://${trimUrl(m)}`);
  return { urls: [...new Set(urls)], linkedinUrls: [...new Set(linkedin)] };
}

/** Long text with at least two job-description words. */
export function looksLikeJobDescription(text: string): boolean {
  const s = String(text ?? '').replace(URL_RE, ' ').trim();
  if (s.length < JD_MIN_CHARS) return false;
  return JD_WORDS.filter((re) => re.test(s)).length >= 2;
}

export function classifyIntake(req: ChatRequest): Intake {
  const { urls, linkedinUrls } = findUrls(req.text);
  const hasImages = (req.images?.length ?? 0) > 0;
  const looksLikeJd = looksLikeJobDescription(req.text);
  const base = { urls, linkedinUrls, hasImages, looksLikeJd };

  // A tapped button already names its expert and action.
  if (req.action) return { rule: 'R0', ...base };
  if (hasImages) return { rule: 'R1', ...base };
  if (linkedinUrls.length && !urls.length) return { rule: 'R3', ...base };
  if (urls.length) return { rule: 'R2', ...base };
  if (looksLikeJd) return { rule: 'R4', ...base };
  return { rule: 'R0', ...base };
}
