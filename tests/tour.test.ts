/** First-run walkthrough: step list, navigation that skips missing targets, popover placement. No DOM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOUR_STEPS,
  TOUR_STORAGE_KEY,
  TOUR_EVENT,
  findStep,
  nextIndex,
  prevIndex,
  stepCounter,
  choosePlacement,
  spotlightRect,
  isRectVisible,
  type TourStep,
} from '../app/chat/tourLogic';

const all = () => true;
const without = (...ids: string[]) => (s: TourStep) => !ids.includes(s.id);

test('six steps in order, welcome first with no target', () => {
  assert.equal(TOUR_STEPS.length, 6);
  assert.deepEqual(
    TOUR_STEPS.map((s) => s.id),
    ['welcome', 'composer', 'attach', 'suggestions', 'spend', 'memory-link'],
  );
  assert.equal(TOUR_STEPS[0]!.target, null);
  for (const s of TOUR_STEPS.slice(1)) assert.match(s.target!, /^\[data-tour="[a-z-]+"\]$/);
  assert.equal(TOUR_STORAGE_KEY, 'jho_tour_v1');
  assert.equal(TOUR_EVENT, 'jho:tour');
});

test('copy has no em dashes or emojis', () => {
  for (const s of TOUR_STEPS) {
    const text = s.title + s.body;
    assert.ok(!text.includes('—'), s.id);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), s.id);
  }
});

test('next and prev walk every step when all are present', () => {
  assert.equal(nextIndex(TOUR_STEPS, 0, all), 1);
  assert.equal(nextIndex(TOUR_STEPS, 4, all), 5);
  assert.equal(nextIndex(TOUR_STEPS, 5, all), -1, 'past the last step the tour finishes');
  assert.equal(prevIndex(TOUR_STEPS, 3, all), 2);
  assert.equal(prevIndex(TOUR_STEPS, 0, all), 0, 'back on the first step stays put');
});

test('missing targets are skipped both ways', () => {
  const ok = without('attach', 'suggestions');
  assert.equal(nextIndex(TOUR_STEPS, 1, ok), 4);
  assert.equal(prevIndex(TOUR_STEPS, 4, ok), 1);
  assert.equal(nextIndex(TOUR_STEPS, 4, without('memory-link')), -1, 'last present step finishes');
  assert.equal(findStep(TOUR_STEPS, 0, 1, without('welcome', 'composer')), 2);
  assert.equal(findStep(TOUR_STEPS, 0, 1, () => false), -1);
});

test('counter counts only present steps', () => {
  assert.deepEqual(stepCounter(TOUR_STEPS, 1, all), { n: 2, total: 6 });
  const ok = without('attach', 'suggestions');
  assert.deepEqual(stepCounter(TOUR_STEPS, 4, ok), { n: 3, total: 4 });
  assert.deepEqual(stepCounter(TOUR_STEPS, 5, ok), { n: 4, total: 4 });
});

const desktop = { width: 1280, height: 800 };
const pop = { width: 340, height: 180 };

test('no target: centred card', () => {
  const p = choosePlacement(null, pop, desktop);
  assert.equal(p.side, 'center');
  assert.equal(p.left, (1280 - 340) / 2);
  assert.equal(p.top, (800 - 180) / 2);
});

test('prefers below, then above, then the side', () => {
  const nearTop = { top: 60, left: 500, width: 200, height: 40 };
  const below = choosePlacement(nearTop, pop, desktop);
  assert.equal(below.side, 'bottom');
  assert.equal(below.top, 60 + 40 + 14);

  const nearBottom = { top: 700, left: 400, width: 480, height: 60 };
  const above = choosePlacement(nearBottom, pop, desktop);
  assert.equal(above.side, 'top');
  assert.equal(above.top + 180 + 14, 700);

  const tall = { top: 100, left: 40, width: 300, height: 600 };
  assert.equal(choosePlacement(tall, pop, desktop).side, 'right');

  const tallRight = { top: 100, left: 900, width: 360, height: 600 };
  assert.equal(choosePlacement(tallRight, pop, desktop).side, 'left');

  const huge = { top: 10, left: 10, width: 1260, height: 780 };
  assert.equal(choosePlacement(huge, pop, desktop).side, 'center');
});

test('popover stays inside the viewport horizontally', () => {
  const edge = { top: 20, left: 1240, width: 30, height: 30 };
  const p = choosePlacement(edge, pop, desktop);
  assert.ok(p.left >= 16);
  assert.ok(p.left + p.width <= 1280 - 16);
  const leftEdge = choosePlacement({ top: 20, left: 0, width: 30, height: 30 }, pop, desktop);
  assert.equal(leftEdge.left, 16);
});

test('390 px: full-width sheet, moved to the top when the target is low', () => {
  const phone = { width: 390, height: 844 };
  const low = choosePlacement({ top: 760, left: 16, width: 358, height: 56 }, pop, phone);
  assert.equal(low.side, 'sheet');
  assert.equal(low.width, 390 - 32);
  assert.equal(low.left, 16);
  assert.equal(low.top, 16);
  const high = choosePlacement({ top: 12, left: 300, width: 60, height: 32 }, pop, phone);
  assert.equal(high.top, 844 - 180 - 16);
  assert.equal(choosePlacement(null, pop, phone).side, 'sheet');
});

test('spotlight pads the target and stays on screen', () => {
  const r = spotlightRect({ top: 100, left: 100, width: 200, height: 50 }, desktop);
  assert.deepEqual(r, { top: 92, left: 92, width: 216, height: 66 });
  const clipped = spotlightRect({ top: 0, left: 0, width: 1280, height: 800 }, desktop);
  assert.deepEqual(clipped, { top: 4, left: 4, width: 1272, height: 792 });
});

test('visibility needs area and overlap with the viewport', () => {
  assert.ok(isRectVisible({ top: 10, left: 10, width: 10, height: 10 }, desktop));
  assert.ok(!isRectVisible({ top: 10, left: 10, width: 0, height: 10 }, desktop));
  assert.ok(!isRectVisible({ top: 900, left: 10, width: 10, height: 10 }, desktop));
  assert.ok(!isRectVisible({ top: -50, left: 10, width: 10, height: 20 }, desktop));
});
