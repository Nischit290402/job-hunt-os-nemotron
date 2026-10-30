/**
 * Deterministic checks for the Outreach expert. The model proposes; this code decides.
 *  - validateCandidate: a contact counts only when the quoted evidence is really on a page we read.
 *  - outreachCheck: a draft passes only when every number is backed by the candidate summary, it links nothing but
 *    the job, the LinkedIn note fits, and the style rules hold.
 */
import type { GateCheck } from '../agents/types';
import { companyMentioned } from './contacts';
import { isLinkedInUrl } from './lead';
import { DEFAULT_LIMITS, type Draft, type OutreachLimits } from './outreach';

export interface Candidate {
  name: string;
  headline: string;
  kind: 'engineer' | 'recruiter';
  source_url: string;
  evidence_quote: string;
  hook: string;
}

export interface Page {
  url: string;
  text: string;
}

/** Lowercase, straight quotes, one space: what "the same text" means when matching a quote against a page. */
export function normText(s: string): string {
  return String(s ?? '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[\s ]+/g, ' ')
    .trim()
    .toLowerCase();
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

export const isBlockedUrl = (u: string) => isLinkedInUrl(u) || /^https?:\/\/([a-z0-9-]+\.)*lnkd\.in(\/|$)/i.test(String(u).trim());

export type CandidateCheck = { ok: true; candidate: Candidate; page: Page } | { ok: false; reason: string };

/** The model's candidate is real only if its quote, its name and the company are all on the page it cites. */
export function validateCandidate(raw: unknown, pages: Page[], company: string): CandidateCheck {
  const r = (raw ?? {}) as Record<string, unknown>;
  const c: Candidate = {
    name: String(r.name ?? '').replace(/\s+/g, ' ').trim(),
    headline: String(r.headline ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    kind: r.kind === 'recruiter' ? 'recruiter' : 'engineer',
    source_url: String(r.source_url ?? '').trim(),
    evidence_quote: String(r.evidence_quote ?? '').replace(/\s+/g, ' ').trim(),
    hook: String(r.hook ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
  if (c.name.length < 3 || c.name.length > 80 || !/\s/.test(c.name)) return { ok: false, reason: 'no full name' };
  if (isBlockedUrl(c.source_url)) return { ok: false, reason: 'LinkedIn is never a source' };
  const page = pages.find((p) => sameUrl(p.url, c.source_url));
  if (!page) return { ok: false, reason: 'source_url is not a page that was read' };
  const text = normText(page.text);
  const quote = normText(c.evidence_quote);
  if (quote.length < 12) return { ok: false, reason: 'evidence quote too short' };
  if (!text.includes(quote)) return { ok: false, reason: 'evidence quote is not on the page' };
  if (!text.includes(normText(c.name))) return { ok: false, reason: 'name is not on the page' };
  if (!companyMentioned(page.text, company)) return { ok: false, reason: 'page does not mention the company' };
  return { ok: true, candidate: c, page };
}

// ---------- draft checks ----------

const FLATTERY = [
  'amazing', 'incredible', 'impressive', 'impressed', 'inspiring', 'inspired by', 'admire', 'brilliant', 'outstanding', 'fantastic',
  'awesome', 'world-class', 'world class', 'visionary', 'legendary', 'huge fan', 'big fan', 'exceptional', 'remarkable', 'stellar',
  'phenomenal', 'groundbreaking', 'rockstar', 'genius',
];

/** Numbers as written ("1,200", "3.5", "92%") reduced to their digits so "1,200" and "1200" compare equal. */
function numbersIn(s: string): string[] {
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, ''));
}

/** "15-minute chat" is the ask the prompt itself requests, not a claim about the candidate. */
const stripDurations = (s: string) => s.replace(/\b\d+\s*-?\s*(min|mins|minute|minutes)\b/gi, ' ');

function urlsIn(s: string): string[] {
  return (String(s).match(/\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''));
}

export interface CheckContext {
  summary: string; // profile.outreach_summary: the only source of facts about the candidate
  allowedText?: string; // company and role title (a year in "2027 Summer Internship" is fine)
  allowedUrls?: string[]; // the job link, when it is a real link
}

export function outreachCheck(d: Draft, ctx: CheckContext, limits: OutreachLimits = DEFAULT_LIMITS): GateCheck[] {
  const all = `${d.subject}\n${d.emailBody}\n${d.linkedinNote}`;
  const backed = new Set(numbersIn(`${ctx.summary}\n${ctx.allowedText ?? ''}`));
  // Digits inside a link (".../jobs/4713038006") are checked by the link rule, not here.
  const prose = stripDurations(all.replace(/\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi, ' '));
  const unbacked = [...new Set(numbersIn(prose).filter((n) => !backed.has(n)))];

  const allowed = (ctx.allowedUrls ?? []).filter(Boolean);
  const badUrls = urlsIn(`${d.subject}\n${d.emailBody}`).filter((u) => !allowed.some((a) => sameUrl(a, u)));
  const noteUrls = urlsIn(d.linkedinNote);

  const flat = all.toLowerCase();
  const flattery = FLATTERY.filter((w) => new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i').test(flat));
  const emDash = /[—]|\s--\s/.test(all);

  return [
    { id: 'numbers', pass: unbacked.length === 0, detail: unbacked.length ? `not in your summary: ${unbacked.join(', ')}` : 'every number comes from your summary' },
    {
      id: 'links',
      pass: badUrls.length === 0 && noteUrls.length === 0,
      detail: badUrls.length || noteUrls.length ? `unexpected link: ${[...badUrls, ...noteUrls].join(', ')}` : allowed.length ? 'only the job link' : 'no links',
    },
    { id: 'note_length', pass: d.linkedinNote.length <= limits.linkedinNoteMax, detail: `LinkedIn note ${d.linkedinNote.length}/${limits.linkedinNoteMax} characters` },
    { id: 'no_em_dash', pass: !emDash, detail: emDash ? 'contains an em dash' : 'no em dashes' },
    { id: 'no_flattery', pass: flattery.length === 0, detail: flattery.length ? `flattery: ${flattery.join(', ')}` : 'no flattery words' },
  ];
}
