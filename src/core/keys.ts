/**
 * Identity of a job posting. The canonical key fixes the v0.3.1 duplicate bug: the same Greenhouse job reached the
 * Sheet twice through two URLs (board link and an aggregator link with utm_source), so keys now come from ATS IDs first.
 */

export function hash12(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) ^ c) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('0000' + (h2 & 0xffff).toString(16)).slice(-4);
}

/** Lower-cases a job link and drops tracking parameters, so the same posting matches across sources. */
export function normUrl(u: string): string {
  let s = String(u || '').trim().toLowerCase();
  if (!/^https?:\/\//.test(s)) return '';
  s = s.replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '');
  const [rawPath, rawQuery = ''] = s.split('?');
  const path = rawPath.replace(/\/+$/, '');
  const q = rawQuery
    .split('&')
    .filter((p) => p && !/^(utm_|ref=|ref$|source=|src=|gh_src|lever-|fbclid|gclid)/.test(p))
    .sort();
  return path + (q.length ? '?' + q.join('&') : '');
}

const LEGAL_SUFFIX = /\b(pte\.?|ltd\.?|limited|inc\.?|llc|l\.l\.c\.|corp\.?|corporation|co\.?|gmbh|plc|lp|llp|group|holdings?)\b/gi;

export function normCompany(name: string): string {
  const s = String(name || '').toLowerCase().replace(LEGAL_SUFFIX, ' ').replace(/[^a-z0-9]+/g, '');
  if (/^(bytedance|tiktok)/.test(s)) return 'bytedance';
  if (/^(google|deepmind)/.test(s)) return 'google';
  if (/^(shopee|sea|garena)$/.test(s) || /^seagroup/.test(s)) return 'sea';
  if (/^amazon/.test(s)) return 'amazon';
  if (/^microsoft/.test(s)) return 'microsoft';
  if (/^nvidia/.test(s)) return 'nvidia';
  if (/^(meta|metaplatforms|facebook)$/.test(s)) return 'meta';
  if (/^jpmorgan/.test(s)) return 'jpmorgan';
  if (/^motional/.test(s)) return 'motional';
  if (/^micron/.test(s)) return 'micron';
  return s;
}

export function cleanTitle(t: unknown): string {
  return String(t ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}☀-➿️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normTitle(title: string): string {
  return cleanTitle(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same company + same normalised title + same SG/non-SG bucket. Used as the secondary, cross-channel match. */
export function xkey(job: { company: string; title: string; location?: string; url?: string }): string {
  const loc = String(job.location || '');
  const sg = /singapore/i.test(`${loc} ${job.title}`) || /(^|[^a-z])sg([^a-z]|$)/i.test(loc);
  let t = normTitle(job.title);
  if (!t) t = 'url:' + hash12(String(job.url || job.title || ''));
  return `${normCompany(job.company)}|${t}|${sg ? 'sg' : 'xx'}`;
}

/**
 * ATS-aware key. Greenhouse job IDs are global, so the board link, a gh_jid link on the company's own site and an
 * aggregator link all collapse to "gh:<id>".
 */
export function canonicalKey(job: { url: string; atsName?: string; atsJobId?: string }): string {
  if (job.atsName && job.atsJobId) {
    const prefix: Record<string, string> = { greenhouse: 'gh', lever: 'lever', ashby: 'ashby', smartrecruiters: 'sr', mcf: 'mcf' };
    return `${prefix[job.atsName] ?? job.atsName}:${String(job.atsJobId).toLowerCase()}`;
  }
  const raw = String(job.url || '');
  const u = raw.toLowerCase();
  let m = u.match(/[?&]gh_jid=(\d+)/) || u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/);
  if (m) return `gh:${m[1]}`;
  m = u.match(/jobs\.lever\.co\/[^/]+\/([0-9a-f-]{36})/);
  if (m) return `lever:${m[1]}`;
  m = u.match(/jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f-]{36})/);
  if (m) return `ashby:${m[1]}`;
  m = u.match(/smartrecruiters\.com\/[^/]+\/(\d{6,})/);
  if (m) return `sr:${m[1]}`;
  m = u.match(/mycareersfuture\.gov\.sg\/job\/(?:[^?#]*-)?([0-9a-f]{32})/);
  if (m) return `mcf:${m[1]}`;
  m = u.match(/^https?:\/\/([^/]+\.myworkdayjobs\.com)\/[^?#]*_([a-z]{0,4}\d{4,}(?:-\d+)?)(?:[/?#]|$)/);
  if (m) return `wd:${m[1].split('.')[0]}:${m[2]}`;
  const n = normUrl(raw);
  return n ? `url:${hash12(n)}` : `x:${hash12(raw)}`;
}
