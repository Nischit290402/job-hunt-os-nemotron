/** Date helpers pinned to Singapore time (UTC+8, no daylight saving). Pure, no dependencies. */

export const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' for the Singapore calendar day that contains `now`. */
export function sgtDate(now: Date | number = Date.now()): string {
  const t = typeof now === 'number' ? now : now.getTime();
  return new Date(t + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant for a Singapore wall-clock time, e.g. sgtAt('2026-10-24', '07:45'). */
export function sgtAt(date: string, hhmm: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hhmm)) {
    throw new Error(`sgtAt: bad input ${date} ${hhmm}`);
  }
  return new Date(Date.parse(`${date}T${hhmm}:00Z`) - SGT_OFFSET_MS);
}

/** Whole days from a to b (b - a), both 'YYYY-MM-DD'. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Converts any parseable date value to a Singapore 'YYYY-MM-DD', or '' when it cannot be parsed. */
export function toSgtDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = typeof v === 'number' || /^\d{12,}$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return sgtDate(d);
}

/** Monday of the Singapore week containing `date`. */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}
