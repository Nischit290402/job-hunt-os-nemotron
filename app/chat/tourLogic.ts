/**
 * Pure logic for the first-run walkthrough: the step list, navigation that skips steps whose target
 * is missing, and popover placement. No DOM here so it runs under node:test.
 */

export const TOUR_STORAGE_KEY = 'jho_tour_v1';
export const TOUR_EVENT = 'jho:tour';
export const TOUR_DELAY_MS = 600;

export interface TourStep {
  id: string;
  /** CSS selector of the spotlight target; null means a centred card with no cut-out. */
  target: string | null;
  title: string;
  body: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to Job Hunt OS',
    body:
      'A private job-hunt assistant. Three NVIDIA Nemotron experts on Nebius Token Factory: one finds and scores jobs, one tailors your resume, one drafts a referral ask. Nothing is sent without your tap.',
  },
  {
    id: 'composer',
    target: '[data-tour="composer"]',
    title: 'Drop anything here',
    body:
      'A screenshot of a post, a careers link, pasted text, or a question. A Nemotron Nano router picks the right expert. No commands to learn.',
  },
  {
    id: 'attach',
    target: '[data-tour="attach"]',
    title: 'Screenshots welcome',
    body: 'Nemotron Super VL reads job posts from images. LinkedIn links are never opened, so screenshots are the way in.',
  },
  {
    id: 'suggestions',
    target: '[data-tour="suggestions"]',
    title: 'Try one',
    body: 'Start with a sample job post, today\'s best matches, or a company search.',
  },
  {
    id: 'spend',
    target: '[data-tour="spend"]',
    title: 'Every step is visible',
    body:
      'Each answer shows which Nemotron model ran, how long it took and what it cost. A daily cap keeps it inside the free credits.',
  },
  {
    id: 'memory-link',
    target: '[data-tour="memory-link"]',
    title: 'You control the data',
    body: 'See exactly what each expert can and cannot see.',
  },
];

/** A step is usable when it has no target or its target is present and visible. */
export type IsAvailable = (step: TourStep, index: number) => boolean;

/** First usable index at or after `from` moving in `dir`; -1 when none is left. */
export function findStep(steps: readonly TourStep[], from: number, dir: 1 | -1, ok: IsAvailable): number {
  for (let i = from; i >= 0 && i < steps.length; i += dir) {
    if (ok(steps[i]!, i)) return i;
  }
  return -1;
}

/** Next usable step after `current`, or -1 when the tour should finish. */
export function nextIndex(steps: readonly TourStep[], current: number, ok: IsAvailable): number {
  return findStep(steps, current + 1, 1, ok);
}

/** Previous usable step before `current`; stays on `current` when there is none. */
export function prevIndex(steps: readonly TourStep[], current: number, ok: IsAvailable): number {
  const i = findStep(steps, current - 1, -1, ok);
  return i === -1 ? current : i;
}

/** Position of `index` among usable steps and how many there are, for the "2 of 6" counter. */
export function stepCounter(steps: readonly TourStep[], index: number, ok: IsAvailable): { n: number; total: number } {
  let n = 0;
  let total = 0;
  steps.forEach((s, i) => {
    if (!ok(s, i)) return;
    total += 1;
    if (i <= index) n += 1;
  });
  return { n: Math.max(1, n), total: Math.max(1, total) };
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type Side = 'center' | 'sheet' | 'bottom' | 'top' | 'right' | 'left';

export interface Placement {
  side: Side;
  top: number;
  left: number;
  width: number;
}

export const SMALL_SCREEN = 560;
const GAP = 14;
const MARGIN = 16;
const MAX_WIDTH = 340;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Choose where the popover goes. Small screens use a bottom sheet. Otherwise prefer below the target,
 * then above, then right, then left; if nothing fits, centre it. `pop` is the measured popover size.
 */
export function choosePlacement(target: Rect | null, pop: { width: number; height: number }, vp: Viewport): Placement {
  const width = Math.min(MAX_WIDTH, vp.width - MARGIN * 2);
  const h = pop.height;
  if (vp.width < SMALL_SCREEN) {
    // Full-width sheet at the bottom, unless the target sits in the bottom half and would be covered.
    const bottomTop = Math.max(MARGIN, vp.height - h - MARGIN);
    const targetLow = target !== null && target.top + target.height / 2 > vp.height / 2;
    return { side: 'sheet', top: targetLow ? MARGIN : bottomTop, left: MARGIN, width: vp.width - MARGIN * 2 };
  }
  const centred: Placement = {
    side: 'center',
    top: Math.max(MARGIN, (vp.height - h) / 2),
    left: Math.max(MARGIN, (vp.width - width) / 2),
    width,
  };
  if (!target) return centred;

  const midX = target.left + target.width / 2;
  const midY = target.top + target.height / 2;
  const hLeft = clamp(midX - width / 2, MARGIN, vp.width - width - MARGIN);
  const vTop = clamp(midY - h / 2, MARGIN, vp.height - h - MARGIN);

  const below = target.top + target.height + GAP;
  if (below + h <= vp.height - MARGIN) return { side: 'bottom', top: below, left: hLeft, width };

  const above = target.top - GAP - h;
  if (above >= MARGIN) return { side: 'top', top: above, left: hLeft, width };

  const right = target.left + target.width + GAP;
  if (right + width <= vp.width - MARGIN) return { side: 'right', top: vTop, left: right, width };

  const left = target.left - GAP - width;
  if (left >= MARGIN) return { side: 'left', top: vTop, left, width };

  return centred;
}

/** Spotlight box around the target with padding, clamped to the viewport so the ring stays visible. */
export function spotlightRect(target: Rect, vp: Viewport, pad = 8): Rect {
  const top = Math.max(4, target.top - pad);
  const left = Math.max(4, target.left - pad);
  const bottom = Math.min(vp.height - 4, target.top + target.height + pad);
  const right = Math.min(vp.width - 4, target.left + target.width + pad);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** A rect counts as visible when it has area and overlaps the viewport. */
export function isRectVisible(r: Rect, vp: Viewport): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  return r.top < vp.height && r.left < vp.width && r.top + r.height > 0 && r.left + r.width > 0;
}
