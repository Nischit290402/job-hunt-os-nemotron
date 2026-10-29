/** Runs the filler against local copies of typical Greenhouse and Lever form markup in headless Chromium. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillAnswers, fillForm, fillPage, keyFor } from './fill';

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
    assert.ok(r.questions.some((q) => /why do you want/i.test(q.label)), 'prose question goes to Claude for a draft');
    assert.equal(await page.evaluate(() => (window as any).__submitted ?? false), false);

    await page.setContent(LEVER);
    const r2 = await fillForm(page, { ...answers, city: 'Singapore' }, null);
    assert.deepEqual(r2.filled.sort(), ['city', 'email', 'full_name', 'github']);
    assert.equal(await page.evaluate(() => (window as any).__submitted ?? false), false);
  } finally {
    await browser.close();
  }
});

const CHOICES = `<form>
  <fieldset><legend>Will you now or in the future require sponsorship? *</legend>
    <label><input type="radio" name="spons" value="yes" required> Yes</label>
    <label><input type="radio" name="spons" value="no"> No</label></fieldset>
  <fieldset><legend>Are you at least 18 years of age?</legend>
    <label><input type="radio" name="age" value="1"> Yes</label>
    <label><input type="radio" name="age" value="0"> No</label></fieldset>
  <fieldset><legend>What is your favourite colour?</legend>
    <label><input type="radio" name="colour" value="r"> Red</label></fieldset>
  <label><input type="checkbox" id="reloc"> I am willing to relocate</label>
  <label><input type="checkbox" id="terms"> I agree to the privacy policy and terms</label>
  <label><input type="checkbox" id="news"> Send me marketing emails</label>
  <div class="field"><label for="why">Why do you want to work at Motional? *</label><textarea id="why" maxlength="800" required></textarea></div>
  <div class="field"><label for="extra">Anything else you would like us to know?</label><input id="extra"></div>
  <div class="field"><label for="salary">Expected salary?</label><input id="salary"></div>
</form>`;

test('radio and checkbox answers from the bank; consent and marketing boxes stay unticked; prose questions captured', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(CHOICES);
    const r = await fillForm(page, { ...answers, needs_sponsorship: 'No', over_18: 'Yes', relocate: 'Yes' }, null);
    assert.equal(await page.isChecked('input[name=spons][value=no]'), true);
    assert.equal(await page.isChecked('input[name=spons][value=yes]'), false);
    assert.equal(await page.isChecked('input[name=age][value="1"]'), true);
    assert.equal(await page.isChecked('input[name=colour]'), false);
    assert.equal(await page.isChecked('#reloc'), true);
    assert.equal(await page.isChecked('#terms'), false, 'consent never ticked');
    assert.equal(await page.isChecked('#news'), false, 'marketing never ticked');
    const labels = r.questions.map((q) => q.label);
    assert.ok(labels.some((l) => /Why do you want to work at Motional/.test(l)));
    assert.ok(labels.some((l) => /Anything else/.test(l)));
    const why = r.questions.find((q) => /Why do you want/.test(q.label))!;
    assert.equal(why.maxLength, 800);
    assert.equal(why.required, true);

    const n = await fillAnswers(page, [{ qid: why.qid, text: 'Because of the behaviours research team.' }, { qid: 'q9', text: 'x' }]);
    assert.equal(n, 1);
    assert.equal(await page.inputValue('#why'), 'Because of the behaviours research team.');
    await page.fill('#extra', 'typed by me');
    const extra = r.questions.find((q) => /Anything else/.test(q.label))!;
    assert.equal(await fillAnswers(page, [{ qid: extra.qid, text: 'draft' }]), 0, 'never overwrites what you typed');
  } finally {
    await browser.close();
  }
});

test('a company page that wraps the hiring-system form in an iframe still gets filled', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://job-boards.greenhouse.io/embed/**', (r) => r.fulfill({ contentType: 'text/html', body: GREENHOUSE }));
    await page.route('https://careers.example.com/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<h1>Careers</h1><iframe src="https://job-boards.greenhouse.io/embed/job_app?for=x"></iframe>' })
    );
    await page.goto('https://careers.example.com/job/1');
    await page.waitForTimeout(500);
    const r = await fillPage(page, answers, null);
    assert.ok(r.filled.includes('first_name') && r.filled.includes('email'));
  } finally {
    await browser.close();
  }
});
