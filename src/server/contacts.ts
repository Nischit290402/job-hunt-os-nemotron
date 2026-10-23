/**
 * Contact finder. Order, stopping at the first good match:
 *  1. your Connections.csv contacts at the company,
 *  2. X-ray search through the Brave Search API (result titles only, never a LinkedIn page request),
 *  3. a verified business email from Hunter for the chosen person (optional),
 *  4. nothing found: Telegram gets a one-tap LinkedIn search link for you to open.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { features } from './env';
import { braveSearch, companyDomain, findEmail } from './search';
import { linkedinSearchUrl, parseConnectionsCsv, parseXrayResult, rankContacts, splitName, xrayQueries, type XrayContact } from '../core/contacts';

const ALUMNI_RE = /nanyang technological|\bntu\b|iit indore|indian institute of technology,? indore/i;

export interface ChosenContact {
  contactId: number;
  name: string;
  hasEmail: boolean;
  relation: string;
}

export async function importConnections(sql: Sql, csvText: string, today: string): Promise<{ imported: number; companies: number }> {
  const rows = parseConnectionsCsv(csvText);
  const companies = new Set<string>();
  let imported = 0;
  for (const c of rows) {
    if (!c.company) continue;
    companies.add(c.company);
    await repo.upsertContact(sql, {
      companyName: c.company, name: `${c.firstName} ${c.lastName}`.trim(), headline: c.position, linkedinUrl: c.url || null,
      email: c.email || null, emailSource: c.email ? 'linkedin_export' : null, emailConfidence: c.email ? 'verified' : null,
      relation: 'connection', kind: /recruit|talent/i.test(c.position) ? 'recruiter' : 'engineer', source: 'connections', today,
    });
    imported++;
  }
  await repo.kvSet(sql, 'connections_imported_on', today);
  return { imported, companies: companies.size };
}

const score = (c: { relation: string; kind: string; email: string | null }) =>
  (c.relation === 'connection' ? 30 : c.relation === 'alumni' ? 20 : 0) + (c.kind === 'engineer' ? 5 : 0) + (c.email ? 10 : 0);

export async function findContact(sql: Sql, app: repo.AppRow, today: string): Promise<{ chosen: ChosenContact | null; searchUrl: string; note: string }> {
  const searchUrl = linkedinSearchUrl(app.company, app.family === 'quant' ? 'quantitative researcher' : 'machine learning engineer');
  let pool = await repo.contactsAtCompany(sql, app.company_id);
  let note = pool.length ? `${pool.length} known contact(s)` : 'no known contacts';

  if (!pool.some((c) => c.relation === 'connection') && features.brave()) {
    const found: XrayContact[] = [];
    for (const { q, kind } of xrayQueries(app.company, app.family)) {
      try {
        for (const r of await braveSearch(q)) {
          const c = parseXrayResult(r, app.company, kind);
          if (c) found.push(c);
        }
      } catch (e) {
        note += `; search error: ${e instanceof Error ? e.message : e}`;
        break;
      }
      if (found.filter((c) => c.confidence === 'high').length >= 3) break;
    }
    for (const c of rankContacts(found, 5)) {
      await repo.upsertContact(sql, {
        companyName: app.company, name: c.name, headline: c.headline, linkedinUrl: c.url, relation: ALUMNI_RE.test(c.snippet) ? 'alumni' : 'cold',
        kind: c.kind, source: 'xray', snippet: c.snippet, today,
      });
    }
    note += `; X-ray found ${found.length}`;
    pool = await repo.contactsAtCompany(sql, app.company_id);
  }
  if (!pool.length) return { chosen: null, searchUrl, note };

  const best = [...pool].sort((a, b) => score(b) - score(a))[0];
  if (!best.email && features.hunter()) {
    const { first, last } = splitName(best.name);
    const domain = companyDomain(app.company, app.url);
    const e = domain ? await findEmail(first, last, domain) : null;
    if (e?.confidence === 'verified') {
      await repo.upsertContact(sql, {
        companyName: app.company, name: best.name, headline: best.headline, linkedinUrl: best.linkedin_url, email: e.email,
        emailSource: e.source, emailConfidence: e.confidence, relation: best.relation, kind: best.kind, source: 'xray', today,
      });
      best.email = e.email;
    }
  }
  return { chosen: { contactId: best.id, name: best.name, hasEmail: !!best.email, relation: best.relation }, searchUrl, note };
}
