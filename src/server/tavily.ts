/**
 * Tavily Search and Extract. Never LinkedIn: linkedin.com and lnkd.in are always excluded and never extracted.
 * Stub from W0: sub-agent B1 fills the bodies.
 */
import type { Sql } from './sql';
import type { TavilyClient, WebResult } from '../agents/types';

export async function tavilySearch(_sql: Sql, _q: string, _o?: Parameters<TavilyClient['search']>[1]): Promise<WebResult[]> {
  throw new Error('tavily not built yet');
}

export async function tavilyExtract(_sql: Sql, _urls: string[]): Promise<{ url: string; text: string }[]> {
  throw new Error('tavily not built yet');
}

export const tavilyFor = (sql: Sql): TavilyClient => ({
  search: (q, o) => tavilySearch(sql, q, o),
  extract: (urls) => tavilyExtract(sql, urls),
});
