/**
 * Nemotron price table and output cleanup. Pure: no I/O, so the money math is unit-tested.
 * Prices are USD per 1M tokens (Nebius Token Factory list prices).
 */
import type { BudgetMode, ModelRole } from '../agents/types';

export interface Price {
  in: number;
  out: number;
}

const NANO: Price = { in: 0.06, out: 0.24 };
const SUPER_VL: Price = { in: 0.3, out: 0.9 };
const ULTRA: Price = { in: 1.0, out: 3.0 };

export const ROLE_PRICES: Record<ModelRole, Price> = { fast: NANO, fallback: NANO, vision: SUPER_VL, reason: ULTRA };

const MODEL_PRICES: [RegExp, Price][] = [
  [/nano|lightning/i, NANO],
  [/super|vl\b|-vl/i, SUPER_VL],
  [/ultra/i, ULTRA],
];

/** Unknown model IDs are priced as Ultra so the budget guard overestimates rather than underestimates. */
export function priceFor(model: string): Price {
  return MODEL_PRICES.find(([re]) => re.test(model))?.[1] ?? ULTRA;
}

export function costUsd(model: string, inTok: number, outTok: number): number {
  const p = priceFor(model);
  return ((inTok || 0) * p.in + (outTok || 0) * p.out) / 1_000_000;
}

/** 'stopped' at either cap, 'saver' at 60% of the daily cap. */
export function budgetModeFor(todayUsd: number, totalUsd: number, dailyCapUsd: number, totalCapUsd: number): BudgetMode {
  if (todayUsd >= dailyCapUsd || totalUsd >= totalCapUsd) return 'stopped';
  if (todayUsd >= 0.6 * dailyCapUsd) return 'saver';
  return 'normal';
}

/**
 * Removes reasoning blocks. A closing tag without an opener means the template opened the block in the prompt,
 * so everything before it is reasoning. A lone opening tag is dropped and the text after it kept.
 */
export function stripThink(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = t.search(/<\/think>/i);
  if (close >= 0) t = t.slice(close + '</think>'.length);
  return t.replace(/<think>/gi, '').trim();
}

/** Index just past the bracket that closes the one at `start`, or -1. String-aware so braces in values do not count. */
function matchEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parses model output that should be JSON: strips ``` fences and takes the first {...} or [...] block. undefined when nothing parses. */
export function parseJsonLoose(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through to block extraction
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{' && s[i] !== '[') continue;
    const end = matchEnd(s, i);
    if (end < 0) continue;
    try {
      return JSON.parse(s.slice(i, end));
    } catch {
      // a stray bracket in prose; try the next one
    }
  }
  return undefined;
}
