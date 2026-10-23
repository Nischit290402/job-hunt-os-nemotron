/**
 * Search and email lookup providers.
 *  - Brave Search API for X-ray and public-page lookups (Google's Custom Search JSON API is closed to new customers
 *    and ends on 1 Jan 2027). The system reads result titles and snippets only; it never requests a LinkedIn page.
 *  - Hunter.io email finder (optional) for a verified business address.
 */
import { env } from './env';
import { httpGet } from './http';
import type { SearchResult } from '../core/contacts';

export async function braveSearch(q: string, count = 10): Promise<SearchResult[]> {
  const r = await httpGet(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}&country=sg&safesearch=moderate`, {
    accept: 'application/json',
    'x-subscription-token': env.braveKey(),
  });
  if (r.status !== 200) throw new Error(`Brave search ${r.status}: ${r.error ?? r.text.slice(0, 120)}`);
  const data = JSON.parse(r.text);
  return (data?.web?.results ?? []).map((x: any) => ({ title: String(x.title ?? '').replace(/<\/?strong>/g, ''), url: x.url, description: String(x.description ?? '').replace(/<\/?strong>/g, '') }));
}

export interface FoundEmail {
  email: string;
  confidence: 'verified' | 'likely';
  source: 'hunter';
}

/** Returns an address only when Hunter reports it verified or scores it 90+; anything weaker is not used for sending. */
export async function findEmail(first: string, last: string, domain: string): Promise<FoundEmail | null> {
  if (!first || !last || !domain) return null;
  const r = await httpGet(
    `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${encodeURIComponent(env.hunterKey())}`
  );
  if (r.status !== 200) return null;
  const d = JSON.parse(r.text)?.data;
  if (!d?.email) return null;
  const status = d.verification?.status;
  if (status === 'valid') return { email: d.email, confidence: 'verified', source: 'hunter' };
  if (Number(d.score) >= 90 && status !== 'invalid') return { email: d.email, confidence: 'likely', source: 'hunter' };
  return null;
}

/** Best guess at the company's email domain from the apply URL or a known map; '' when unknown. */
export function companyDomain(company: string, applyUrl: string): string {
  const known: Record<string, string> = {
    bytedance: 'bytedance.com', tiktok: 'bytedance.com', google: 'google.com', jpmorgan: 'jpmorgan.com', drw: 'drw.com', hudsonrivertrading: 'hudson-trading.com',
    jumptrading: 'jumptrading.com', towerresearchcapital: 'tower-research.com', optiver: 'optiver.com', applovin: 'applovin.com',
    razer: 'razer.com', grab: 'grab.com', sea: 'sea.com', imctrading: 'imc.com', imc: 'imc.com',
  };
  const key = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const [k, d] of Object.entries(known)) if (key.startsWith(k)) return d;
  const host = (applyUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? '').toLowerCase();
  if (!host || /greenhouse|lever|ashby|workday|smartrecruiters|mycareersfuture|freehire|linkedin|icims|workable/.test(host)) return '';
  return host.split('.').slice(-2).join('.');
}
