/**
 * Finds the official apply route for MyCareersFuture and aggregator jobs before they reach Today (see core/route.ts).
 * Two Brave searches per job at most, only for jobs good enough to be shown, so the free plan's quota holds.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { features } from './env';
import { braveSearch } from './search';
import { extractApplyEmail, pickRoute, routeQueries, ROUTE_CHANNELS } from '../core/route';

export async function resolveRoutes(sql: Sql, limit = 15): Promise<{ checked: number; official: number; email: number; none: number; note: string }> {
  const out = { checked: 0, official: 0, email: 0, none: 0, note: '' };
  if (!features.brave()) return { ...out, note: 'BRAVE_SEARCH_API_KEY not set: routes not checked' };
  for (const j of await repo.jobsNeedingRoute(sql, ROUTE_CHANNELS, limit)) {
    let url: string | null = null;
    try {
      for (const q of routeQueries(j.company, j.title)) {
        url = pickRoute(await braveSearch(q, 10), j.company, j.title);
        if (url) break;
      }
    } catch (e) {
      out.note = `search error: ${e instanceof Error ? e.message.slice(0, 120) : e}`;
      break; // leave the rest unchecked; the next run retries them
    }
    out.checked++;
    if (url) {
      await repo.setRoute(sql, j.id, 'official', url, null);
      out.official++;
      continue;
    }
    const email = extractApplyEmail(j.jd_text ?? '');
    if (email) {
      await repo.setRoute(sql, j.id, 'email', null, email);
      out.email++;
    } else {
      await repo.setRoute(sql, j.id, 'none', null, null);
      out.none++;
    }
  }
  return out;
}
