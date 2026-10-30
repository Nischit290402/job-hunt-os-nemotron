/**
 * ResumeDoc: the structured resume Ultra writes and pdf-lib renders (plan 4.9).
 * The code owns the layout, so the one-page check is exact and the model only chooses content.
 * Bullet priority: 1 = keep at all costs, 5 = drop first when the page overflows.
 */

export interface ResumeBullet {
  text: string;
  priority: number; // 1 (most important) to 5 (dropped first)
}

export interface ResumeHeader {
  name: string;
  email: string;
  github: string;
  phone: string;
  location: string;
}

export type ResumeBase = 'ML' | 'CVResearch' | 'Backend';

export interface ResumeDoc {
  header: ResumeHeader;
  education: { school: string; degree: string; dates: string; detail: string }[];
  experience: { org: string; role: string; location: string; dates: string; bullets: ResumeBullet[] }[];
  projects: { name: string; dates: string; bullets: ResumeBullet[] }[];
  publications: string[];
  skills: { label: string; items: string }[];
  meta: { base: ResumeBase; match_pct: number; covered: string[]; gaps: string[]; changes: string[] };
}

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;
const bullets = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'priority'],
    properties: {
      text: str,
      priority: { type: 'integer', description: '1 = most important, 5 = drop first if the page overflows' },
    },
  },
} as const;

/** JSON schema for strict structured output: every field required, no extra keys. */
export const RESUME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['header', 'education', 'experience', 'projects', 'publications', 'skills', 'meta'],
  properties: {
    header: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'email', 'github', 'phone', 'location'],
      properties: { name: str, email: str, github: str, phone: str, location: str },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['school', 'degree', 'dates', 'detail'],
        properties: { school: str, degree: str, dates: str, detail: str },
      },
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['org', 'role', 'location', 'dates', 'bullets'],
        properties: { org: str, role: str, location: str, dates: str, bullets },
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'dates', 'bullets'],
        properties: { name: str, dates: str, bullets },
      },
    },
    publications: strArr,
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'items'],
        properties: { label: str, items: str },
      },
    },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['base', 'match_pct', 'covered', 'gaps', 'changes'],
      properties: {
        base: { type: 'string', enum: ['ML', 'CVResearch', 'Backend'] },
        match_pct: { type: 'integer', description: 'share of the posting must-haves the master shows, 0 to 100' },
        covered: strArr,
        gaps: strArr,
        changes: strArr,
      },
    },
  },
} as const;

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strList = (v: unknown): string[] => arr(v).map(s).filter(Boolean);

function normBullets(v: unknown): ResumeBullet[] {
  return arr(v)
    .map((b) => {
      if (typeof b === 'string') return { text: b.trim(), priority: 3 };
      const o = obj(b);
      const p = Math.round(Number(o.priority));
      return { text: s(o.text), priority: Number.isFinite(p) ? Math.min(5, Math.max(1, p)) : 3 };
    })
    .filter((b) => b.text.length > 0);
}

/** Coerces whatever the model returned into a well-formed ResumeDoc (missing parts become empty, never undefined). */
export function normalizeResumeDoc(raw: unknown): ResumeDoc {
  const r = obj(raw);
  const h = obj(r.header);
  const m = obj(r.meta);
  const base = s(m.base);
  const pct = Math.round(Number(m.match_pct));
  return {
    header: { name: s(h.name), email: s(h.email), github: s(h.github), phone: s(h.phone), location: s(h.location) },
    education: arr(r.education)
      .map(obj)
      .map((e) => ({ school: s(e.school), degree: s(e.degree), dates: s(e.dates), detail: s(e.detail) }))
      .filter((e) => e.school || e.degree),
    experience: arr(r.experience)
      .map(obj)
      .map((e) => ({ org: s(e.org), role: s(e.role), location: s(e.location), dates: s(e.dates), bullets: normBullets(e.bullets) }))
      .filter((e) => e.org || e.role || e.bullets.length),
    projects: arr(r.projects)
      .map(obj)
      .map((p) => ({ name: s(p.name), dates: s(p.dates), bullets: normBullets(p.bullets) }))
      .filter((p) => p.name || p.bullets.length),
    publications: strList(r.publications),
    skills: arr(r.skills)
      .map(obj)
      .map((k) => ({ label: s(k.label), items: s(k.items) }))
      .filter((k) => k.items),
    meta: {
      base: base === 'CVResearch' || base === 'Backend' ? base : 'ML',
      match_pct: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0,
      covered: strList(m.covered),
      gaps: strList(m.gaps),
      changes: strList(m.changes),
    },
  };
}

/** Every bullet in page order (experience first, then projects). */
export function allBullets(doc: ResumeDoc): ResumeBullet[] {
  return [...doc.experience.flatMap((e) => e.bullets), ...doc.projects.flatMap((p) => p.bullets)];
}

/** Keeps at most `max` bullets, dropping the lowest-priority ones (5 first, later bullets first on ties). Pure; returns how many went. */
export function capBullets(doc: ResumeDoc, max: number): { doc: ResumeDoc; dropped: number } {
  const all = allBullets(doc);
  if (all.length <= max) return { doc, dropped: 0 };
  const ranked = all.map((b, i) => ({ b, i })).sort((x, y) => y.b.priority - x.b.priority || y.i - x.i);
  const drop = new Set(ranked.slice(0, all.length - max).map((x) => x.b));
  const keep = (bs: ResumeBullet[]) => bs.filter((b) => !drop.has(b));
  return {
    doc: { ...doc, experience: doc.experience.map((e) => ({ ...e, bullets: keep(e.bullets) })), projects: doc.projects.map((p) => ({ ...p, bullets: keep(p.bullets) })) },
    dropped: drop.size,
  };
}
