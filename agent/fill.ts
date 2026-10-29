/**
 * Form filler for apply pages. Fills what it can match from your answer bank, attaches the resume, and stops.
 * It never clicks Submit, never touches CAPTCHAs, and never overwrites a field that already has a value.
 */
import type { Page, Locator } from 'playwright';

export type Answers = Record<string, string>;

/** Label patterns to answer-bank keys. First match wins, so specific patterns come first. */
export const RULES: { re: RegExp; key: string }[] = [
  { re: /first\s*name|given\s*name|preferred\s*first/i, key: 'first_name' },
  { re: /last\s*name|family\s*name|surname/i, key: 'last_name' },
  { re: /^(full\s*)?name\b|your name|legal name/i, key: 'full_name' },
  { re: /e-?mail/i, key: 'email' },
  { re: /phone|mobile|contact number/i, key: 'phone' },
  { re: /linked\s*in/i, key: 'linkedin' },
  { re: /git\s*hub/i, key: 'github' },
  { re: /website|portfolio|personal (site|url)|other url/i, key: 'website' },
  { re: /google scholar/i, key: 'scholar' },
  { re: /(current )?(city|location)\b(?!.*relocat)/i, key: 'city' },
  { re: /country/i, key: 'country' },
  { re: /university|school|college|institution/i, key: 'school' },
  { re: /degree|qualification/i, key: 'degree' },
  { re: /(field|area) of study|major|discipline/i, key: 'major' },
  { re: /graduat(ion|e) (date|year)|expected graduation|grad date/i, key: 'graduation' },
  { re: /(require|need).*(sponsor|visa)|sponsorship/i, key: 'needs_sponsorship' },
  { re: /(legally )?(authori[sz]ed|eligible) to work/i, key: 'work_authorized' },
  { re: /notice period|earliest start|available to start|start date/i, key: 'start_date' },
  { re: /how did you hear|source|referr(al|ed) by/i, key: 'heard_from' },
  { re: /pronoun/i, key: 'pronouns' },
  { re: /previously (worked|been employed)|former employee|worked (here|for us) before/i, key: 'previously_employed' },
  { re: /relocat/i, key: 'relocate' },
  { re: /(18|eighteen) (years|or older)|over (the age of )?18|at least 18/i, key: 'over_18' },
];

/** Boxes the agent never ticks: consent, terms, declarations, marketing. Those are yours to read and tick. */
export const CONSENT = /agree|consent|terms|privacy|certif|acknowledg|declar|confirm|accurate|true and complete|policy|gdpr|pdpa|marketing|subscribe|newsletter|communications|sms|whatsapp/i;

/** "Yes" / "No" / "Y" / "true" style answers, or null when the answer is free text. */
export function yesNo(answer: string | undefined): 'yes' | 'no' | null {
  const a = String(answer ?? '').trim().toLowerCase();
  if (/^(yes|y|true)\b/.test(a)) return 'yes';
  if (/^(no|n|false)\b/.test(a)) return 'no';
  return null;
}

/** Labels that read as a question to answer in prose (why us, describe, tell us...). */
export function isProseQuestion(label: string): boolean {
  return /\?|\b(why|describe|tell us|explain|what (makes|interests|excites|are)|how (would|do|did|have)|cover letter|additional information|anything else|motivation|interest in)\b/i.test(label);
}

export interface FillReport {
  filled: string[];
  missing: string[]; // required fields left empty
  resumeAttached: boolean;
  questions: OpenQuestion[]; // prose questions left empty, for Claude to draft
}

export interface OpenQuestion {
  qid: string;
  label: string;
  maxLength: number | null;
  required: boolean;
}

async function labelOf(page: Page, el: Locator): Promise<string> {
  return el.evaluate((node: Element) => {
    const e = node as HTMLInputElement;
    const parts: string[] = [];
    if (e.id) {
      const l = node.ownerDocument.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      if (l) parts.push(l.textContent || '');
    }
    const wrap = node.closest('label');
    if (wrap) parts.push(wrap.textContent || '');
    const by = e.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach((id) => parts.push(node.ownerDocument.getElementById(id)?.textContent || ''));
    parts.push(e.getAttribute('aria-label') || '', e.getAttribute('placeholder') || '', e.getAttribute('name') || '');
    if (!parts.join('').trim()) {
      const field = node.closest('.field, .form-group, .application-question, fieldset, li, div');
      if (field) parts.push((field.textContent || '').slice(0, 200));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  });
}

export function keyFor(label: string): string | null {
  const l = label.replace(/[*:]/g, ' ').trim();
  for (const r of RULES) if (r.re.test(l)) return r.key;
  return null;
}

export async function fillForm(page: Page, answers: Answers, resumePath: string | null): Promise<FillReport> {
  const report: FillReport = { filled: [], missing: [], resumeAttached: false, questions: [] };

  // Resume upload first: some ATS forms parse it and pre-fill other fields.
  if (resumePath) {
    for (const input of await page.locator('input[type="file"]').all()) {
      const label = (await labelOf(page, input)).toLowerCase();
      if (/resume|cv|curriculum/.test(label) || (await page.locator('input[type="file"]').count()) === 1) {
        await input.setInputFiles(resumePath);
        report.resumeAttached = true;
        await page.waitForTimeout(1500);
        break;
      }
    }
  }

  const fields = await page.locator('input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select').all();
  for (const el of fields) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const label = await labelOf(page, el);
    if (/captcha|recaptcha/i.test(label)) continue;
    const key = keyFor(label);
    const tag = await el.evaluate((n: Element) => n.tagName.toLowerCase());
    const required = await el.evaluate((n: Element) => (n as HTMLInputElement).required || n.getAttribute('aria-required') === 'true');
    const current = tag === 'select' ? await el.evaluate((n: Element) => (n as HTMLSelectElement).selectedIndex > 0) : (await el.inputValue().catch(() => '')) !== '';
    if (current) continue;
    const value = key ? answers[key] : undefined;
    if (!value) {
      const clean = label.replace(/\s*\*\s*/g, ' ').trim();
      const prose = !key && (tag === 'textarea' || isProseQuestion(clean));
      if (prose && report.questions.length < 8) {
        const qid = `q${report.questions.length + 1}`;
        await el.evaluate((n: Element, id: string) => n.setAttribute('data-jh-qid', id), qid);
        const max = await el.evaluate((n: Element) => Number((n as HTMLInputElement).maxLength) > 0 ? Number((n as HTMLInputElement).maxLength) : null);
        report.questions.push({ qid, label: clean.slice(0, 300), maxLength: max, required: required || /\*/.test(label) });
      } else if (required || /\*/.test(label)) report.missing.push(clean.slice(0, 60));
      continue;
    }
    if (tag === 'select') {
      const options = await el.locator('option').allTextContents();
      const pick = options.find((o) => o.trim().toLowerCase() === value.toLowerCase()) ?? options.find((o) => o.toLowerCase().includes(value.toLowerCase()));
      if (pick) {
        await el.selectOption({ label: pick });
        report.filled.push(key!);
      } else if (required) report.missing.push(label.slice(0, 60));
    } else {
      await el.fill(value);
      report.filled.push(key!);
    }
  }
  await fillChoices(page, answers, report);
  return report;
}

/** Radio groups and single checkboxes answered from yes/no entries in your answer bank. Consent boxes are never ticked. */
async function fillChoices(page: Page, answers: Answers, report: FillReport) {
  // Radio groups, by name.
  const radios = await page.locator('input[type=radio]').all();
  const groups = new Map<string, Locator[]>();
  for (const r of radios) {
    if (!(await r.isVisible().catch(() => false))) continue;
    const name = (await r.getAttribute('name')) ?? '';
    if (!name) continue;
    groups.set(name, [...(groups.get(name) ?? []), r]);
  }
  for (const [, opts] of groups) {
    if (await Promise.all(opts.map((o) => o.isChecked())).then((c) => c.some(Boolean))) continue;
    const question = await opts[0].evaluate((n: Element) => {
      const holder = n.closest('fieldset, [role=radiogroup], .field, .form-group, .application-question, li') as HTMLElement | null;
      const legend = holder?.querySelector('legend, label:not(:has(input)), .label, .question, h3, h4, p');
      return ((legend?.textContent || holder?.getAttribute('aria-label') || holder?.textContent || '') as string).replace(/\s+/g, ' ').trim().slice(0, 300);
    });
    if (CONSENT.test(question)) continue;
    const key = keyFor(question);
    const yn = key ? yesNo(answers[key]) : null;
    const want = key ? String(answers[key] ?? '').trim().toLowerCase() : '';
    if (!key || !want) {
      if (opts.length && (await opts[0].evaluate((n: Element) => (n as HTMLInputElement).required))) report.missing.push(question.slice(0, 60));
      continue;
    }
    for (const o of opts) {
      const text = (await labelOf(page, o)).toLowerCase();
      const value = String((await o.getAttribute('value')) ?? '').toLowerCase();
      const hit = yn ? new RegExp(`^\\s*${yn}\\b`).test(text) || value === yn || value === (yn === 'yes' ? 'true' : 'false') : text.trim() === want || value === want;
      if (hit) {
        await o.check();
        report.filled.push(key);
        break;
      }
    }
  }
  // Single checkboxes ("I will require sponsorship"): ticked only when the matching answer is a plain yes.
  for (const c of await page.locator('input[type=checkbox]').all()) {
    if (!(await c.isVisible().catch(() => false)) || (await c.isChecked())) continue;
    const label = await labelOf(page, c);
    if (CONSENT.test(label)) continue;
    const key = keyFor(label);
    if (key && yesNo(answers[key]) === 'yes') {
      await c.check();
      report.filled.push(key);
    }
  }
}

/** Types Claude's drafted answers into the questions it was asked about, only where the field is still empty. */
export async function fillAnswers(page: Page, answers: { qid: string; text: string }[]): Promise<number> {
  let n = 0;
  for (const a of answers) {
    if (!a.text?.trim()) continue;
    const el = page.locator(`[data-jh-qid="${a.qid}"]`).first();
    if (!(await el.count()) || (await el.inputValue().catch(() => 'x')) !== '') continue;
    await el.fill(a.text);
    n++;
  }
  return n;
}
