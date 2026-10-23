/**
 * Firecrawl, markdown scrape only, for job search (careers pages with no API, and job descriptions behind JavaScript).
 * Hard caps come from the runs table: daily, monthly and lifetime. A cap reached means no call, never an overrun.
 */
import type { Sql } from './sql';
import { env, features } from './env';
import { httpPost } from './http';
import { firecrawlCredits } from './repo';

export type ScrapeResult = { state: 'ok'; markdown: string; credits: number } | { state: 'skipped' | 'failed'; note: string; credits: number };

export async function capsAllow(sql: Sql, today: string): Promise<{ ok: boolean; note: string }> {
  if (!features.firecrawl()) return { ok: false, note: 'FIRECRAWL_API_KEY not set' };
  const c = await firecrawlCredits(sql, today);
  if (c.today >= env.firecrawlDailyCap()) return { ok: false, note: `daily cap ${env.firecrawlDailyCap()} reached` };
  if (c.month >= env.firecrawlMonthlyCap()) return { ok: false, note: `monthly cap ${env.firecrawlMonthlyCap()} reached` };
  if (c.total >= env.firecrawlLifetimeCap()) return { ok: false, note: `lifetime cap ${env.firecrawlLifetimeCap()} reached` };
  return { ok: true, note: '' };
}

export async function scrape(sql: Sql, url: string, today: string): Promise<ScrapeResult> {
  const cap = await capsAllow(sql, today);
  if (!cap.ok) return { state: 'skipped', note: cap.note, credits: 0 };
  const res = await httpPost('https://api.firecrawl.dev/v2/scrape', { url, formats: ['markdown'] }, { authorization: `Bearer ${env.firecrawlKey()}` }, 90_000);
  if (res.status !== 200) return { state: 'failed', note: `firecrawl ${res.status} ${res.error ?? res.text.slice(0, 120)}`, credits: 0 };
  const data = JSON.parse(res.text);
  const credits = Number(data?.data?.metadata?.creditsUsed ?? 1);
  if (!data?.success || typeof data?.data?.markdown !== 'string') return { state: 'failed', note: 'firecrawl returned no markdown', credits };
  return { state: 'ok', markdown: data.data.markdown, credits };
}
