/**
 * Leads you add by hand from Telegram, usually from something you saw on LinkedIn:
 *
 *   /lead Motional | Machine Learning Intern | Jane Tan | https://motional.com/careers/123
 *   <job description pasted on the following lines, optional>
 *
 * Company and role are required; person and link are optional (use "-" to skip the person). Labelled lines also work:
 * "Company: ...", "Role: ...", "Person: ...", "Link: ...", "JD: ...". The app never opens LinkedIn links.
 */

export interface Lead {
  company: string;
  role: string;
  person: string;
  link: string;
  jd: string;
}

export type LeadParse = { ok: true; lead: Lead } | { ok: false; error: string };

export const LEAD_USAGE =
  'Usage: /lead Company | Role | Person | Link, then the job description on the next lines. Person and link are optional (use - to skip the person). Example:\n/lead Motional | Machine Learning Intern | Jane Tan | https://motional.com/careers/123';

const LABEL = /^(company|role|title|person|contact|poster|link|url|jd|description)\s*:\s*(.*)$/i;

export function isLinkedInUrl(u: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(u.trim());
}

export function parseLead(text: string): LeadParse {
  const body = String(text || '').replace(/^\/lead(@\w+)?\s*/i, '');
  const lines = body.split(/\r?\n/);
  const out: Lead = { company: '', role: '', person: '', link: '', jd: '' };

  if (lines.some((l) => LABEL.test(l.trim()))) {
    let inJd = false;
    const jd: string[] = [];
    for (const raw of lines) {
      const l = raw.trim();
      const m = l.match(LABEL);
      if (m && !inJd) {
        const [k, v] = [m[1].toLowerCase(), m[2].trim()];
        if (k === 'company') out.company = v;
        else if (k === 'role' || k === 'title') out.role = v;
        else if (k === 'person' || k === 'contact' || k === 'poster') out.person = v;
        else if (k === 'link' || k === 'url') out.link = v;
        else {
          inJd = true;
          if (v) jd.push(v);
        }
      } else if (inJd) jd.push(raw);
    }
    out.jd = jd.join('\n').trim();
  } else {
    const head = lines[0].split('|').map((p) => p.trim());
    [out.company = '', out.role = '', out.person = '', out.link = ''] = head;
    // A link given in the person slot (no person): move it.
    if (/^https?:\/\//i.test(out.person) && !out.link) [out.person, out.link] = ['', out.person];
    out.jd = lines.slice(1).join('\n').trim();
  }

  if (out.person === '-') out.person = '';
  out.company = out.company.slice(0, 120);
  out.role = out.role.slice(0, 200);
  out.person = out.person.replace(/\s+/g, ' ').slice(0, 80);
  out.jd = out.jd.slice(0, 20000);
  if (!out.company || !out.role) return { ok: false, error: LEAD_USAGE };
  if (out.link && !/^https?:\/\/\S+$/i.test(out.link)) return { ok: false, error: `That link does not look like a URL: ${out.link}` };
  return { ok: true, lead: out };
}

/** A stable placeholder URL for a lead without a usable link, so it dedupes like any other job. */
export function leadUrl(lead: Lead, hash: (s: string) => string): string {
  if (lead.link && !isLinkedInUrl(lead.link)) return lead.link;
  return `https://lead.jobhunt.local/${hash(`${lead.company.toLowerCase()}|${lead.role.toLowerCase()}`)}`;
}

/**
 * What you typed with the screenshots. Either the /lead head line ("Company | Role | Person | Link", any field may be
 * empty) or free text: a URL becomes the link and the rest the person, e.g. "Jane Tan https://acme.com/jobs/1".
 */
export function screenshotCaption(caption: string): Partial<Lead> {
  const c = String(caption || '').replace(/^\/lead(@\w+)?\s*/i, '').split(/\r?\n/)[0].trim();
  if (!c) return {};
  if (c.includes('|')) {
    const [company = '', role = '', person = '', link = ''] = c.split('|').map((x) => x.trim());
    return { company, role, person: person === '-' ? '' : person, link: /^https?:\/\/\S+$/i.test(link) ? link : '' };
  }
  const link = (c.match(/https?:\/\/\S+/) ?? [''])[0];
  const person = c.replace(link, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { person, link };
}

/**
 * The lead the worker read off your screenshots, cleaned like a typed /lead; what you typed with them wins.
 * Returns null when the screenshots show no job. LinkedIn links are kept for reference but never opened.
 */
export function leadFromScreenshot(o: Record<string, unknown>, caption = ''): Lead | null {
  if (o.readable === false) return null;
  const s = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const typed = screenshotCaption(caption);
  let link = s(o.link, 500);
  if (link && !/^https?:\/\//i.test(link) && /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(link)) link = `https://${link}`;
  if (!/^https?:\/\/\S+$/i.test(link)) link = '';
  const location = s(o.location, 120);
  const lead: Lead = {
    company: (typed.company || s(o.company, 120)).slice(0, 120),
    role: (typed.role || s(o.role, 200)).slice(0, 200),
    person: (typed.person || s(o.person, 80)).slice(0, 80),
    link: typed.link || link,
    jd: [location ? `Location: ${location}` : '', String(o.jd ?? '').trim()].filter(Boolean).join('\n').slice(0, 20000),
  };
  return lead.company && lead.role ? lead : null;
}
