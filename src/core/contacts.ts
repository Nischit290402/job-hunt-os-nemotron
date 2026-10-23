/**
 * Contact discovery helpers. No LinkedIn page is ever requested by the system:
 *  - your own Connections.csv export (parsed here),
 *  - search-engine "X-ray" results (query builder + result parser here; the search API call lives in the adapter),
 *  - a one-tap LinkedIn search link that YOU open as the last fallback.
 */
import { normCompany } from './keys';

// ---------- Connections.csv ----------

export interface Connection {
  firstName: string;
  lastName: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
}

/** RFC 4180-style CSV line splitter over the whole text (handles quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

/** LinkedIn's export starts with a few "Notes:" lines before the header row; they are skipped. */
export function parseConnectionsCsv(text: string): Connection[] {
  const rows = parseCsv(text);
  const h = rows.findIndex((r) => r[0]?.trim().toLowerCase() === 'first name');
  if (h < 0) throw new Error('Connections.csv header row ("First Name,Last Name,...") not found');
  const head = rows[h].map((x) => x.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const idx = {
    first: col('first name'), last: col('last name'), url: col('url'), email: col('email address'),
    company: col('company'), position: col('position'), on: col('connected on'),
  };
  return rows.slice(h + 1).map((r) => ({
    firstName: (r[idx.first] ?? '').trim(),
    lastName: (r[idx.last] ?? '').trim(),
    url: (r[idx.url] ?? '').trim(),
    email: idx.email >= 0 ? (r[idx.email] ?? '').trim() : '',
    company: (r[idx.company] ?? '').trim(),
    position: (r[idx.position] ?? '').trim(),
    connectedOn: (r[idx.on] ?? '').trim(),
  })).filter((c) => c.firstName || c.lastName);
}

// ---------- X-ray search ----------

export type ContactKind = 'engineer' | 'recruiter';

const ROLE_QUERIES: Record<string, string[]> = {
  quant: ['quantitative researcher', 'machine learning'],
  cv: ['computer vision', 'machine learning engineer'],
  'llm/nlp': ['machine learning engineer', 'research scientist'],
  research: ['research engineer', 'research scientist'],
  ml: ['machine learning engineer', 'data scientist'],
};

/** At most `max` queries: engineer queries for the job family first, then one recruiter query. */
export function xrayQueries(company: string, family: string, location = 'Singapore', max = 5): { q: string; kind: ContactKind }[] {
  const roles = ROLE_QUERIES[family] ?? ROLE_QUERIES.ml;
  const out: { q: string; kind: ContactKind }[] = roles.map((r) => ({ q: `site:linkedin.com/in "${company}" "${r}" ${location}`, kind: 'engineer' }));
  out.push({ q: `site:linkedin.com/in "${company}" ("talent acquisition" OR "university recruiter" OR "campus recruiter") ${location}`, kind: 'recruiter' });
  return out.slice(0, max);
}

export interface SearchResult {
  title: string;
  url: string;
  description?: string;
}

export interface XrayContact {
  name: string;
  headline: string;
  url: string;
  kind: ContactKind;
  confidence: 'high' | 'medium';
  snippet: string;
}

const RECRUITER_RE = /recruit|talent|hiring|people partner|\bhr\b|human resources/i;

const COMPANY_ALIASES: Record<string, string[]> = {
  bytedance: ['bytedance', 'tiktok'],
  google: ['google', 'deepmind'],
  sea: ['shopee', 'seagroup', 'garena', 'seamoney', 'monee'],
  meta: ['meta', 'facebook'],
};

/** True when free text names the company (handles legal suffixes and a few known brand aliases). */
export function companyMentioned(text: string, company: string): boolean {
  const flat = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const key = normCompany(company);
  const raw = String(company || '').toLowerCase().replace(/\b(pte|ltd|limited|inc|llc|corp|corporation|group|holdings?)\b\.?/g, '').replace(/[^a-z0-9]+/g, '');
  const names = new Set([key, raw, ...(COMPANY_ALIASES[key] ?? [])].filter((n) => n.length >= 3));
  return [...names].some((n) => flat.includes(n));
}

/** Canonical public profile URL: https://www.linkedin.com/in/<slug>. Anything else returns ''. */
export function canonicalProfileUrl(u: string): string {
  const m = String(u || '').match(/^https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : '';
}

/**
 * Turns one search result into a contact when it is a LinkedIn profile that names the company.
 * Typical titles: "Jane Tan - Machine Learning Engineer - TikTok | LinkedIn", "Jane Tan – TikTok | LinkedIn".
 */
export function parseXrayResult(r: SearchResult, company: string, fallbackKind: ContactKind): XrayContact | null {
  const url = canonicalProfileUrl(r.url);
  if (!url) return null;
  const title = String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '').trim();
  const parts = title.split(/\s+[-–|]\s+/).map((p) => p.trim()).filter(Boolean);
  const name = parts[0] ?? '';
  if (!name || /\d/.test(name) || name.split(/\s+/).length > 5 || /linkedin/i.test(name)) return null;
  const headline = parts.slice(1).join(' - ');
  const desc = String(r.description || '');
  const inTitle = parts.slice(1).some((p) => companyMentioned(p, company));
  const inDesc = companyMentioned(desc, company);
  if (!inTitle && !inDesc) return null;
  const kind: ContactKind = RECRUITER_RE.test(headline) ? 'recruiter' : RECRUITER_RE.test(desc.slice(0, 160)) ? 'recruiter' : fallbackKind;
  return { name, headline, url, kind, confidence: inTitle ? 'high' : 'medium', snippet: desc.slice(0, 280) };
}

/** Dedupes by profile URL, keeps high confidence first, engineers before recruiters. */
export function rankContacts(cs: XrayContact[], limit = 5): XrayContact[] {
  const seen = new Set<string>();
  return cs
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1) || (a.kind === b.kind ? 0 : a.kind === 'engineer' ? -1 : 1))
    .slice(0, limit);
}

/** Last fallback: a link YOU open. The system never loads it. */
export function linkedinSearchUrl(company: string, role: string, location = 'Singapore'): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${company} ${role} ${location}`)}`;
}

/** Splits "Jane Tan" into first and last name for email-pattern lookups. */
export function splitName(full: string): { first: string; last: string } {
  const p = full.replace(/\(.*?\)/g, ' ').replace(/,.*$/, '').trim().split(/\s+/);
  return { first: p[0] ?? '', last: p.length > 1 ? p[p.length - 1] : '' };
}
