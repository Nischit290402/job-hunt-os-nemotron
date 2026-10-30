/** One-page PDF rendering, WinAnsi safety and demo masking. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { maskForDemo, renderResumePdf, resumeHtml, sanitizeWinAnsi } from '../src/server/resumePdf';
import { makeDoc } from './resumeFixtures';

const u = (...cps: number[]) => String.fromCodePoint(...cps);

test('a normal doc renders one page with nothing dropped', async () => {
  const r = await renderResumePdf(makeDoc(), { demo: false });
  assert.ok(r.pdfBase64.startsWith('JVBER'));
  assert.equal(r.pages, 1);
  assert.equal(r.dropped, 0);
  const pdf = await PDFDocument.load(Buffer.from(r.pdfBase64, 'base64'));
  assert.equal(pdf.getPageCount(), 1);
});

test('a 20-bullet doc still renders one page, dropping low-priority bullets', async () => {
  const doc = makeDoc(20, 18);
  doc.publications.push(...Array.from({ length: 4 }, (_, i) => `Paper ${i}: a long title about hyperspectral image denoising with blind noise estimation and many datasets`));
  const r = await renderResumePdf(doc, { demo: false });
  assert.ok(r.pdfBase64.startsWith('JVBER'));
  assert.equal(r.pages, 1);
  assert.ok(r.dropped > 0, `expected drops, got ${r.dropped}`);
  assert.ok(r.dropped < 20);
});

test('non-WinAnsi text does not throw', async () => {
  const doc = makeDoc();
  const weird = `Shipped ${u(0x201c)}fast${u(0x201d)} path ${u(0x2192)} 2x ${u(0x2014)} caf${u(0xe9)} ${u(0x142)}${u(0x219)} ${u(0x4e2d, 0x6587)} ${u(0x1f680)} ${u(0x2264)} ${u(0x2026)} ${u(0x200b)}end`;
  doc.header.name = `Nischit ${u(0x1f600)} Hosamani`;
  doc.experience[0].bullets[0].text = weird;
  doc.skills[0].items = `Python ${u(0x2022)} C++ ${u(0x2122)} ${u(0x3b1, 0x3b2)}`;
  const r = await renderResumePdf(doc, { demo: false });
  assert.ok(r.pdfBase64.startsWith('JVBER'));
  const s = sanitizeWinAnsi(weird);
  assert.ok(s.includes('"fast"') && s.includes('->') && s.includes(`caf${u(0xe9)}`) && s.includes('<=') && s.includes('...'));
  assert.ok(![...s].some((c) => c.codePointAt(0)! > 0xff && c !== u(0x2022)));
});

test('demo mode masks phone and email in the header', async () => {
  const doc = makeDoc();
  doc.header.location = 'Singapore, call +65 8123 4567 or nischitv29@gmail.com';
  const html = resumeHtml(doc, { demo: true });
  assert.ok(!html.includes('8123'));
  assert.ok(!html.includes('nischitv29@gmail.com'));
  assert.ok(html.includes('phone on request') && html.includes('email on request'));
  assert.ok(html.includes('github.com/Nischit290402'), 'github is public and stays');
  const real = resumeHtml(makeDoc(), { demo: false });
  assert.ok(real.includes('nischitv29@gmail.com') && real.includes('+65 8123 4567'));
  const m = maskForDemo(doc, true);
  assert.equal(m.header.phone, 'phone on request');
  assert.equal(m.header.email, 'email on request');
  const r = await renderResumePdf(doc, { demo: true });
  assert.equal(r.pages, 1);
});

test('resumeHtml escapes markup from the doc', () => {
  const doc = makeDoc();
  doc.skills[0].items = '<script>alert(1)</script>';
  assert.ok(!resumeHtml(doc, { demo: false }).includes('<script>'));
});
