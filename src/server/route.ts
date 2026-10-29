/**
 * Finds the official apply route for MyCareersFuture and aggregator jobs before they reach Today (see core/route.ts).
 * Two Brave searches per job at most, only for jobs good enough to be shown, so the free plan's quota holds.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { features } from './env';
import { braveSearch } from './search';
import { httpGet } from './http';
import { htmlToText } from '../core/html';
import { BOARD_APIS, bestPosting, boardSlugs, extractApplyEmail, pickRoute, routeQueries, ROUTE_CHANNELS, titleOverlap } from '../core/route';

/** The company's own job board (Greenhouse, Lever, Ashby public APIs): exact, and no search quota. */
async function boardLookup(company: string, title: string): Promise<string | null> {
  for (const slug of boardSlugs(company)) {
    for (const b of BOARD_APIS) {
      const r = await httpGet(b.url(slug), { accept: 'application/json' }, 12_000);
      if (r.status !== 200) continue;
      try {
        const hit = bestPosting(b.parse(r.text, slug), title);
        if (hit) return hit.url;
      } catch {
        // not that board's format: try the next one
      }
    }
  }
  return null;
}

/** Reads a hiring-system page to confirm it is this job (its search title was generic). */
async function pageHasTitle(url: string, title: string): Promise<boolean> {
  const r = await httpGet(url, {}, 12_000);
  return r.status === 200 && titleOverlap(title, htmlToText(r.text).slice(0, 4000)) >= 0.75;
}

export async function resolveRoutes(sql: Sql, limit = 15): Promise<{ checked: number; official: number; email: number; none: number; note: string }> {
  const out = { checked: 0, official: 0, email: 0, none: 0, note: '' };
  const canSearch = features.brave();
  for (const j of await repo.jobsNeedingRoute(sql, ROUTE_CHANNELS, limit)) {
    let url: string | null = await boardLookup(j.company, j.title).catch(() => null);
    try {
      for (const q of url || !canSearch ? [] : routeQueries(j.company, j.title)) {
        url = await pickRoute(await braveSearch(q, 10), j.company, j.title, (u) => pageHasTitle(u, j.title));
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
    if (!email && !canSearch) {
      out.checked--; // without search we cannot rule an official page out: leave it unchecked rather than hide it
      continue;
    }
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
