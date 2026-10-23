/** Runs the filler against local copies of typical Greenhouse and Lever form markup in headless Chromium. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillForm, keyFor } from './fill';

const answers = {
  first_name: 'Nischit', last_name: 'Hosamani', full_name: 'Nischit Hosamani', email: 'me@example.com', phone: '+65 0000 0000',
  linkedin: 'https://www.linkedin.com/in/example', github: 'https://github.com/example', needs_sponsorship: 'Yes', country: 'Singapore',
};

const GREENHOUSE = `<form id="application_form">
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" required></div>
  <div class="field"><label for="email">Email *</label><input id="email" type="email" required></div>
  <div class="field"><label for="phone">Phone</label><input id="phone" value="+1 prefilled"></div>
  <div class="field"><label for="resume">Resume/CV *</label><input id="resume" type="file" required></div>
  <div class="field"><label for="q1">LinkedIn Profile</label><input id="q1"></div>
  <div class="field"><label for="q2">Will you now or in the future require sponsorship for employment visa status? *</label>
    <select id="q2" required><option value="">Select...</option><option>Yes</option><option>No</option></select></div>
  <div class="field"><label for="q3">Why do you want to join us? *</label><textarea id="q3" required></textarea></div>
  <div class="g-recaptcha"><input aria-label="captcha response" id="captcha"></div>
  <input type="submit" value="Submit Application" onclick="window.__submitted = true; return false;">
</form>`;

const LEVER = `<form><ul>
  <li class="application-question"><label>Full name<input name="name"></label></li>
  <li class="application-question"><label>Email<input name="email"></label></li>
  <li class="application-question"><label>GitHub URL<input name="urls[GitHub]"></label></li>
  <li class="application-question"><label>Current location<input name="location"></label></li>
</ul><button type="submit" onclick="window.__submitted = true">Submit application</button></form>`;

test('maps common ATS labels to answer keys', () => {
  assert.equal(keyFor('First Name *'), 'first_name');
  assert.equal(keyFor('Will you now or in the future require sponsorship for employment visa status?'), 'needs_sponsorship');
  assert.equal(keyFor('Why do you want to join us?'), null);
});

test('fills a Greenhouse-style form, attaches the resume, keeps existing values, never submits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fill-'));
  const pdf = join(dir, 'r.pdf');
  writeFileSync(pdf, '%PDF-1.4\n%%EOF');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(GREENHOUSE);
    const r = await fillForm(page, answers, pdf);
    assert.equal(r.resumeAttached, true);
    assert.deepEqual(r.filled.sort(), ['email', 'first_name', 'last_name', 'linkedin', 'needs_sponsorship']);
    assert.equal(await page.inputValue('#phone'), '+1 prefilled');
    assert.equal(await page.inputValue('#captcha'), '');
    assert.ok(r.missing.some((m) => /why do you want/i.test(m)));
    assert.equal(await page.evaluate(() => (window as any).__submitted ?? false), false);

    await page.setContent(LEVER);
    const r2 = await fillForm(page, { ...answers, city: 'Singapore' }, null);
    assert.deepEqual(r2.filled.sort(), ['city', 'email', 'full_name', 'github']);
    assert.equal(await page.evaluate(() => (window as any).__submitted ?? false), false);
  } finally {
    await browser.close();
  }
});
