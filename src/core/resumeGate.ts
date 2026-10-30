/**
 * Code gates for a tailored ResumeDoc. They replace verify.py on this branch: deterministic, cheap, and shown to the user
 * as a table, so a failed check is visible rather than hidden behind a model's own judgement.
 */
import type { GateCheck } from '../agents/types';
import { allBullets, type ResumeDoc } from './resumeDoc';

export const FILLER = ['results-driven', 'team player', 'passionate', 'hardworking', 'detail-oriented', 'various', 'successfully'];

const BULLET_MIN = 11;
const BULLET_MAX = 14;
const WORDS_MIN = 12;
const WORDS_MAX = 38;

const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

/** A number token in canonical form: commas dropped, trailing zeros after a point dropped ("1,200" -> "1200", "48.90" -> "48.9"). */
function canon(tok: string): string | null {
  const n = Number(tok.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return String(Number(n.toFixed(6)));
}

export function numbersIn(text: string): string[] {
  return (text.match(NUM_RE) ?? []).map((t) => canon(t.replace(/,$/, ''))).filter((x): x is string => x !== null);
}

/**
 * Numbers the master supports. Money is written in millions on the resume, so a master figure in crore or lakh also
 * supports its value in millions (1.2 Cr -> 12, 50 lakh -> 5).
 */
export function masterNumbers(master: string): Set<string> {
  const set = new Set(numbersIn(master));
  const money = /(\d[\d,]*(?:\.\d+)?)\s*(cr\b|crore|crores|lakh|lakhs|lac\b)/gi;
  for (const m of master.matchAll(money)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    const millions = /^(cr|crore)/i.test(m[2]) ? v * 10 : v / 10;
    set.add(String(Number(millions.toFixed(6))));
  }
  return set;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean);
const short = (t: string) => `"${words(t).slice(0, 5).join(' ')}..."`;
const list = (xs: string[], n = 3) => xs.slice(0, n).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');

/** Every string a reader sees on the page. */
function allText(doc: ResumeDoc): string[] {
  const h = doc.header;
  return [
    h.name,
    h.email,
    h.github,
    h.phone,
    h.location,
    ...doc.education.flatMap((e) => [e.school, e.degree, e.dates, e.detail]),
    ...doc.experience.flatMap((e) => [e.org, e.role, e.location, e.dates, ...e.bullets.map((b) => b.text)]),
    ...doc.projects.flatMap((p) => [p.name, p.dates, ...p.bullets.map((b) => b.text)]),
    ...doc.publications,
    ...doc.skills.flatMap((k) => [k.label, k.items]),
  ];
}

const FIRST_PERSON = [/\bI\b/, /\b(me|my|mine|myself|we|our|ours|ourselves)\b/i, /\bus\b/];

const lower = (t: string) => t.toLowerCase();
const digits = (t: string) => t.replace(/\D/g, '');
const bareUrl = (t: string) => lower(t).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

export function resumeGate(doc: ResumeDoc, masterText: string): { pass: boolean; checks: GateCheck[] } {
  const bullets = allBullets(doc).map((b) => b.text);
  const checks: GateCheck[] = [];
  const add = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });

  // grounded_numbers: an invented figure is the worst failure a tailored resume can have.
  const known = masterNumbers(masterText);
  const invented: string[] = [];
  for (const b of bullets) for (const n of numbersIn(b)) if (!known.has(n) && !invented.includes(n)) invented.push(n);
  add(
    'grounded_numbers',
    invented.length === 0,
    invented.length === 0 ? 'Every number in the bullets appears in your master.' : `Not in your master: ${list(invented, 5)}.`
  );

  const count = bullets.length;
  add(
    'bullet_count',
    count >= BULLET_MIN && count <= BULLET_MAX,
    `${count} bullets (target ${BULLET_MIN} to ${BULLET_MAX}).`
  );

  // quantified: relaxed when the master itself has few figures, so the gate never pushes toward inventing numbers.
  const masterFigures = [...known].filter((n) => !/^(19|20)\d\d$/.test(n)).length;
  const relaxed = masterFigures < 15;
  const need = relaxed ? 0.7 : 0.85;
  const withNum = bullets.filter((b) => /\d/.test(b)).length;
  const share = count ? withNum / count : 0;
  add(
    'quantified',
    count > 0 && share >= need,
    `${withNum} of ${count} bullets have a number (${Math.round(share * 100)}%, need ${Math.round(need * 100)}%` +
      (relaxed ? '; relaxed because your master has few figures' : '') +
      ').'
  );

  const badLen = bullets.filter((b) => {
    const n = words(b).length;
    return n < WORDS_MIN || n > WORDS_MAX;
  });
  add(
    'bullet_words',
    count > 0 && badLen.length === 0,
    badLen.length === 0
      ? `All bullets are ${WORDS_MIN} to ${WORDS_MAX} words.`
      : `${badLen.length} outside ${WORDS_MIN} to ${WORDS_MAX} words: ${list(badLen.map((b) => `${short(b)} (${words(b).length})`), 2)}.`
  );

  const dashed = allText(doc).filter((t) => t.includes('\u2014'));
  add('no_em_dash', dashed.length === 0, dashed.length === 0 ? 'No em dashes.' : `Em dash in ${list(dashed.map(short), 2)}.`);

  const fp = bullets.filter((b) => FIRST_PERSON.some((re) => re.test(b)));
  add('no_first_person', fp.length === 0, fp.length === 0 ? 'No first-person pronouns.' : `First person in ${list(fp.map(short), 2)}.`);

  const textLower = [...bullets, ...doc.skills.map((k) => k.items)].map(lower);
  const filler = FILLER.filter((f) => textLower.some((t) => new RegExp(`\\b${f.replace(/-/g, '[- ]')}\\b`).test(t)));
  add('no_filler', filler.length === 0, filler.length === 0 ? 'No filler words.' : `Filler: ${filler.join(', ')}.`);

  const verbs = bullets.map((b) => lower(words(b)[0] ?? '').replace(/[^a-z-]/g, ''));
  const repeated = [...new Set(verbs.filter((v, i) => v && verbs.indexOf(v) !== i))];
  add(
    'distinct_verbs',
    count > 0 && repeated.length === 0,
    repeated.length === 0 ? 'Each bullet opens with a different verb.' : `Repeated opening verbs: ${repeated.join(', ')}.`
  );

  const ml = lower(masterText);
  const mlDigits = digits(masterText);
  const h = doc.header;
  const missing: string[] = [];
  if (!h.name || !ml.includes(lower(h.name))) missing.push('name');
  if (h.email && !ml.includes(lower(h.email))) missing.push('email');
  if (h.github && !ml.includes(bareUrl(h.github))) missing.push('github');
  if (h.phone && (digits(h.phone).length < 6 || !mlDigits.includes(digits(h.phone)))) missing.push('phone');
  add(
    'header_from_master',
    missing.length === 0,
    missing.length === 0 ? 'Header matches your master.' : `Header ${missing.join(', ')} not found in your master.`
  );

  return { pass: checks.every((c) => c.pass), checks };
}
