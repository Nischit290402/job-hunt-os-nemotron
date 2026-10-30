'use client';
/**
 * First-run guided walkthrough. Dims the page, spotlights one element at a time and explains it in a
 * small popover. Runs once per browser (localStorage `jho_tour_v1`); a `jho:tour` window event restarts it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import s from './tour.module.css';
import {
  TOUR_DELAY_MS,
  TOUR_EVENT,
  TOUR_STEPS,
  TOUR_STORAGE_KEY,
  choosePlacement,
  findStep,
  nextIndex,
  prevIndex,
  spotlightRect,
  type Placement,
  type Rect,
  type TourStep,
} from './tourLogic';

/** Restart the walkthrough from anywhere, for a "Take the tour" link. */
export function restartTour(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TOUR_EVENT));
}

/** Ready-made "Take the tour" button; style it with your own className. */
export function TourButton({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <button type="button" className={className} onClick={restartTour}>
      {children ?? 'Take the tour'}
    </button>
  );
}

function readDone(): boolean {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === 'done';
  } catch {
    return false;
  }
}

function writeDone(): void {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, 'done');
  } catch {
    // Private mode or blocked storage: the tour may show again next visit, which is harmless.
  }
}

function targetEl(step: TourStep): HTMLElement | null {
  if (!step.target || typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(step.target);
}

function isAvailable(step: TourStep): boolean {
  if (!step.target) return true;
  const el = targetEl(step);
  if (!el || el.getClientRects().length === 0) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export default function Tour() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const frame = useRef(0);

  const ok = useCallback((step: TourStep) => isAvailable(step), []);

  const start = useCallback(() => {
    const first = findStep(TOUR_STEPS, 0, 1, ok);
    if (first === -1) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIndex(first);
    setOpen(true);
  }, [ok]);

  const close = useCallback((focusComposer: boolean) => {
    writeDone();
    setOpen(false);
    setSpot(null);
    setPlace(null);
    const composerInput = focusComposer
      ? document.querySelector<HTMLElement>('[data-tour="composer"] textarea, [data-tour="composer"] input[type="text"]')
      : null;
    const back = composerInput ?? returnFocus.current;
    if (back && document.contains(back)) back.focus();
  }, []);

  const goNext = useCallback(() => {
    const n = nextIndex(TOUR_STEPS, index, ok);
    if (n === -1) close(true);
    else setIndex(n);
  }, [index, ok, close]);

  const goBack = useCallback(() => setIndex(prevIndex(TOUR_STEPS, index, ok)), [index, ok]);

  // First visit: start after a short pause so the page has settled. Always listen for restarts.
  useEffect(() => {
    const t = readDone() ? undefined : window.setTimeout(start, TOUR_DELAY_MS);
    const onRestart = () => start();
    window.addEventListener(TOUR_EVENT, onRestart);
    return () => {
      if (t !== undefined) window.clearTimeout(t);
      window.removeEventListener(TOUR_EVENT, onRestart);
    };
  }, [start]);

  // Measure the target and the popover, then place both.
  const measure = useCallback(() => {
    if (!open) return;
    const step = TOUR_STEPS[index]!;
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const pop = popRef.current;
    const popSize = { width: pop?.offsetWidth ?? 320, height: pop?.offsetHeight ?? 200 };
    if (!step.target) {
      setSpot(null);
      setPlace(choosePlacement(null, popSize, vp));
      return;
    }
    if (!isAvailable(step)) {
      // The target vanished mid-tour (for example the suggestions after a first message): move on.
      goNext();
      return;
    }
    const r = toRect(targetEl(step)!.getBoundingClientRect());
    setSpot(spotlightRect(r, vp));
    setPlace(choosePlacement(r, popSize, vp));
  }, [open, index, goNext]);

  // On each step: bring the target into view, then measure (twice, so the popover height is known).
  useLayoutEffect(() => {
    if (!open) return;
    const el = targetEl(TOUR_STEPS[index]!);
    if (el) {
      try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      } catch {
        el.scrollIntoView();
      }
    }
    measure();
    frame.current = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame.current);
  }, [open, index, measure]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onChange = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [open, measure]);

  // Focus the primary action whenever the step changes.
  useEffect(() => {
    if (open) primaryRef.current?.focus({ preventScroll: true });
  }, [open, index]);

  // Keyboard: Esc skips, arrows navigate, Tab stays inside the popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Tab') {
        const pop = popRef.current;
        if (!pop) return;
        const items = Array.from(pop.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (!pop.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, goNext, goBack, close]);

  if (!open) return null;

  const step = TOUR_STEPS[index]!;
  // Total counts every step: targets that load late (the spend pill) must not make the counter jump.
  const n = index + 1;
  const total = TOUR_STEPS.length;
  const isLast = nextIndex(TOUR_STEPS, index, ok) === -1;
  const canBack = prevIndex(TOUR_STEPS, index, ok) !== index;
  const titleId = `jho-tour-title-${step.id}`;
  const bodyId = `jho-tour-body-${step.id}`;

  // No target: a zero-size spotlight in the centre still casts the full-page dim.
  const ring = spot ?? { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 };
  const popStyle = place
    ? { top: place.top, left: place.left, width: place.width }
    : { top: -9999, left: 0, width: Math.min(340, window.innerWidth - 32) };

  return (
    <div className={s.root}>
      <div className={s.blocker} aria-hidden="true" />
      <div
        className={`${s.spot} ${spot ? '' : s.spotEmpty}`}
        style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height }}
        aria-hidden="true"
      />
      <div
        ref={popRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={`${s.pop} ${place ? s[place.side] ?? '' : ''}`}
        style={popStyle}
      >
        <div className={s.counter} aria-live="polite">
          {n} of {total}
        </div>
        <h2 id={titleId} className={s.title}>
          {step.title}
        </h2>
        <p id={bodyId} className={s.body}>
          {step.body}
        </p>
        <div className={s.dots} aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={i + 1 === n ? s.dotOn : s.dot} />
          ))}
        </div>
        <div className={s.actions}>
          <button type="button" className={s.skip} onClick={() => close(false)}>
            Skip tour
          </button>
          <div className={s.nav}>
            {canBack && (
              <button type="button" className={s.back} onClick={goBack}>
                Back
              </button>
            )}
            <button ref={primaryRef} type="button" className={s.next} onClick={goNext}>
              {isLast ? 'Start' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
