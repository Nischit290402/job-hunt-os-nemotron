/**
 * The Claude work queue. The app never calls a model itself: it queues a task, starts your Claude Code scheduled task
 * over HTTP, and the worker (that scheduled task, or Claude Code on your laptop) claims tasks, does them with your
 * skills and posts results back. Pure helpers only; the queries live in server/repo.ts.
 */

export const TASK_KINDS = ['coach', 'tailor', 'draft', 'judge'] as const; // claim order: the person waiting comes first
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
    case 'coach':
      return typeof o.text === 'string' && o.text.trim() ? null : 'expected {"text": "..."}';
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
  };
}

/** Text sent with each fire. The scheduled task's prompt tells it to treat this as a hint only. */
export function fireText(reason: string, queued: Record<string, number>): string {
  const parts = Object.entries(queued)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return `Job Hunt OS: ${reason}. Queued: ${parts.join(', ') || 'nothing'}.`;
}
