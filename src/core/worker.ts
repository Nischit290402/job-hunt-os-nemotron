/**
 * The Claude work queue. The app never calls a model itself: it queues a task, starts your Claude Code scheduled task
 * over HTTP, and the worker (that scheduled task, or Claude Code on your laptop) claims tasks, does them with your
 * skills and posts results back. Pure helpers only; the queries live in server/repo.ts.
 */

export const TASK_KINDS = ['coach', 'answers', 'lead', 'tailor', 'draft', 'judge'] as const; // claim order: the person waiting comes first
export type TaskKind = (typeof TASK_KINDS)[number];

export const CLAIM_TTL_MIN = 20; // a claim older than this is treated as abandoned and handed out again
export const MAX_ATTEMPTS = 3;
export const LAPTOP_AFTER_MIN = 10; // the laptop picks up work the cloud has not claimed within this many minutes
export const FIRE_DEBOUNCE_MS = 90_000; // one fire covers every task queued while that run is alive
export const MAX_RESULT_CHARS = 1_500_000; // a tailored PDF in base64 is about 100 KB

/** What the worker sees for one task. `instructions` is the system prompt, `input` the user message. */
export interface TaskView {
  id: number;
  kind: TaskKind;
  instructions: string;
  input: string;
  schema: object | null; // JSON schema the answer must match; null for free text (coach) and tailor
  meta: Record<string, unknown>;
  images?: { mime: string; b64: string }[]; // screenshots for a lead task
}

/** Start a run unless one started in the last 90 s and has not reported idle since (it will pick the new work up). */
export function shouldFire(lastFireMs: number | null, nowMs: number, lastIdleMs: number | null = null): boolean {
  if (lastFireMs === null || nowMs - lastFireMs >= FIRE_DEBOUNCE_MS) return true;
  return lastIdleMs !== null && lastIdleMs >= lastFireMs;
}

export interface TailorResultIn {
  tex: string;
  pdfBase64: string;
  summary: string;
  verifyPassed: boolean | null;
  verifyOutput: string;
  base: string;
}

/** Checks a worker's result before the app acts on it. Returns an error string or null. */
export function resultError(kind: TaskKind, r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'result must be a JSON object';
  if (JSON.stringify(r).length > MAX_RESULT_CHARS) return 'result too large';
  const o = r as Record<string, unknown>;
  switch (kind) {
    case 'judge':
    case 'draft':
      return o.output && typeof o.output === 'object' ? null : 'expected {"output": {...matching the schema}}';
    case 'answers': {
      const a = (o.output as { answers?: unknown })?.answers;
      if (!Array.isArray(a)) return 'expected {"output": {"answers": [{"qid": "q1", "text": "..."}]}}';
      return a.every((x) => x && typeof x.qid === 'string' && typeof x.text === 'string') ? null : 'each answer needs qid and text';
    }
    case 'coach':
      return typeof o.text === 'string' && o.text.trim() ? null : 'expected {"text": "..."}';
    case 'lead': {
      const l = o.output as Record<string, unknown> | undefined;
      if (!l || typeof l !== 'object') return 'expected {"output": {"company": "...", "role": "...", ...}}';
      if (l.readable === false) return null;
      return typeof l.company === 'string' && l.company.trim() && typeof l.role === 'string' && l.role.trim() ? null : 'company and role are required (or set "readable": false)';
    }
    case 'tailor': {
      if (typeof o.tex !== 'string' || !o.tex.includes('\\begin{document}')) return 'expected the full LaTeX in "tex"';
      if (typeof o.pdfBase64 !== 'string' || !o.pdfBase64.startsWith('JVBER')) return 'expected the compiled PDF in "pdfBase64"';
      if (!(o.verifyPassed === true || o.verifyPassed === false || o.verifyPassed === null)) return 'verifyPassed must be true, false or null';
      return null;
    }
  }
}

/** Builds the worker's view from a stored task. */
export function toView(t: { id: number; kind: TaskKind; payload: Record<string, unknown> }): TaskView {
  const p = t.payload;
  return {
    id: Number(t.id),
    kind: t.kind,
    instructions: String(p.instructions ?? ''),
    input: String(p.input ?? ''),
    schema: (p.schema as object) ?? null,
    meta: (p.meta as Record<string, unknown>) ?? {},
    ...(Array.isArray(p.images) ? { images: p.images as TaskView['images'] } : {}),
  };
}

/** Text sent with each fire. The scheduled task's prompt tells it to treat this as a hint only. */
export function fireText(reason: string, queued: Record<string, number>): string {
  const parts = Object.entries(queued)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return `Job Hunt OS: ${reason}. Queued: ${parts.join(', ') || 'nothing'}.`;
}

/** Schema for drafted application answers. An empty text means "leave this one for Nischit". */
export const ANSWERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['qid', 'text'],
        properties: { qid: { type: 'string' }, text: { type: 'string', maxLength: 3000 } },
      },
    },
  },
} as const;

export interface OpenQuestionIn {
  qid: string;
  label: string;
  maxLength: number | null;
  required: boolean;
}

/** Validates what the laptop agent sends. Returns clean questions or null. */
export function cleanQuestions(q: unknown): OpenQuestionIn[] | null {
  if (!Array.isArray(q) || !q.length) return null;
  const out = q.slice(0, 8).map((x: any) => ({
    qid: String(x?.qid ?? '').slice(0, 8),
    label: String(x?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    maxLength: Number.isInteger(x?.maxLength) && x.maxLength > 0 ? Math.min(x.maxLength, 5000) : null,
    required: x?.required === true,
  }));
  return out.every((x) => /^q\d{1,2}$/.test(x.qid) && x.label) ? out : null;
}

/** What the worker reads off a job screenshot. `readable: false` when the images show no job at all. */
export const LEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'company', 'role', 'person', 'link', 'location', 'jd'],
  properties: {
    readable: { type: 'boolean' },
    company: { type: 'string', maxLength: 120 },
    role: { type: 'string', maxLength: 200 },
    person: { type: 'string', maxLength: 80 },
    link: { type: 'string', maxLength: 500 },
    location: { type: 'string', maxLength: 120 },
    jd: { type: 'string', maxLength: 20000 },
  },
} as const;
