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
];

export interface FillReport {
  filled: string[];
  missing: string[]; // required fields left empty
  resumeAttached: boolean;
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
  const report: FillReport = { filled: [], missing: [], resumeAttached: false };

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
      if (required || /\*/.test(label)) report.missing.push(label.replace(/\s*\*\s*/g, '').slice(0, 60));
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
  return report;
}
