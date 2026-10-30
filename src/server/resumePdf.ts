/**
 * Renders a ResumeDoc to a one-page Letter PDF with pdf-lib (pure JS: no pdflatex, no font fetch, works on Vercel).
 * The code does the layout, so the one-page rule is exact: on overflow it first tightens the body size, then drops the
 * lowest-priority bullets until the page fits, and reports how many it dropped.
 * resumeHtml() is the print-to-PDF fallback if the renderer ever fails.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ResumeDoc } from '../core/resumeDoc';

const PAGE_W = 612; // Letter, in points
const PAGE_H = 792;
const MARGIN = 36; // 0.5 in
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BULLET_INDENT = 12;
const BODY_SIZES = [10, 9.5];

// ---------- text safety ----------

const MAP: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u21D2': '=>', '\u2191': 'up ', '\u2193': 'down ',
  '\u2026': '...', '\u2264': '<=', '\u2265': '>=', '\u2248': '~', '\u2260': '!=', '\u2122': '(TM)',
  '\u00A0': ' ', '\u2009': ' ', '\u200A': ' ', '\u2002': ' ', '\u2003': ' ', '\u202F': ' ', '\t': ' ', '\n': ' ', '\r': ' ',
  '\u2023': '-', '\u25AA': '-', '\u25CF': '-', '\u00B7': '-',
};

/** WinAnsi-safe subset: printable ASCII, Latin-1 letters and symbols, and the bullet. */
const safeChar = (c: string) => {
  const n = c.codePointAt(0)!;
  return (n >= 0x20 && n <= 0x7e) || (n >= 0xa1 && n <= 0xff && n !== 0xad) || n === 0x2022;
};

/** Maps typographic characters to WinAnsi equivalents and drops anything a standard PDF font cannot encode. */
export function sanitizeWinAnsi(text: string, allowed?: Set<number>): string {
  const ok = (c: string) => safeChar(c) && (!allowed || allowed.has(c.codePointAt(0)!));
  let out = '';
  for (const ch of String(text ?? '')) {
    const mapped = MAP[ch];
    if (mapped !== undefined) out += mapped;
    else if (ok(ch)) out += ch;
    else {
      // accented letters outside Latin-1 keep their base letter via NFKD; anything else is dropped
      for (const part of ch.normalize('NFKD')) if (ok(part)) out += part;
    }
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

// ---------- demo masking ----------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/g;

function maskText(t: string): string {
  return t.replace(EMAIL_RE, 'email on request').replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? 'phone on request' : m));
}

/** In demo mode the header never shows a real phone number or email address. */
export function maskForDemo(doc: ResumeDoc, demo: boolean): ResumeDoc {
  if (!demo) return doc;
  const h = doc.header;
  return {
    ...doc,
    header: {
      name: maskText(h.name),
      email: h.email ? 'email on request' : '',
      phone: h.phone ? 'phone on request' : '',
      github: maskText(h.github),
      location: maskText(h.location),
    },
  };
}

const contactLine = (h: ResumeDoc['header']) => [h.location, h.phone, h.email, h.github].filter(Boolean).join('  |  ');

// ---------- layout ----------

type Op =
  | { k: 'text'; x: number; y: number; text: string; font: PDFFont; size: number }
  | { k: 'rule'; y: number };

interface Fonts {
  reg: PDFFont;
  bold: PDFFont;
  ital: PDFFont;
  allowed: Set<number>;
}

function wrap(text: string, font: PDFFont, size: number, firstWidth: number, restWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const width = lines.length === 0 ? firstWidth : restWidth;
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || font.widthOfTextAtSize(next, size) <= width) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Bullet ids in page order, with the entry each belongs to. */
function bulletIndex(doc: ResumeDoc) {
  const out: { id: string; entry: string; priority: number; order: number }[] = [];
  doc.experience.forEach((e, i) => e.bullets.forEach((b, j) => out.push({ id: `e${i}.${j}`, entry: `e${i}`, priority: b.priority, order: out.length })));
  doc.projects.forEach((p, i) => p.bullets.forEach((b, j) => out.push({ id: `p${i}.${j}`, entry: `p${i}`, priority: b.priority, order: out.length })));
  return out;
}

/** Next bullet to drop: highest priority number, preferring entries that keep at least one bullet, later on the page first. */
function nextDrop(doc: ResumeDoc, dropped: Set<string>): string | null {
  const live = bulletIndex(doc).filter((b) => !dropped.has(b.id));
  if (!live.length) return null;
  const perEntry = new Map<string, number>();
  for (const b of live) perEntry.set(b.entry, (perEntry.get(b.entry) ?? 0) + 1);
  live.sort((a, b) => {
    const aKeep = (perEntry.get(a.entry) ?? 0) > 1 ? 0 : 1;
    const bKeep = (perEntry.get(b.entry) ?? 0) > 1 ? 0 : 1;
    return aKeep - bKeep || b.priority - a.priority || b.order - a.order;
  });
  return live[0].id;
}

/** Lays the page out top-down; y is the distance from the top edge of the content area. Returns ops and used height. */
function layout(doc: ResumeDoc, f: Fonts, size: number, dropped: Set<string>): { ops: Op[]; height: number } {
  const ops: Op[] = [];
  const S = (t: string) => sanitizeWinAnsi(t, f.allowed);
  const lh = size * 1.22;
  let y = 0;

  const text = (t: string, x: number, font: PDFFont, sz: number) => ops.push({ k: 'text', x, y, text: t, font, size: sz });
  const centered = (t: string, font: PDFFont, sz: number) => {
    for (const line of wrap(t, font, sz, CONTENT_W, CONTENT_W)) {
      y += sz * 1.25;
      text(line, MARGIN + (CONTENT_W - font.widthOfTextAtSize(line, sz)) / 2, font, sz);
    }
  };
  const row = (left: string, right: string, lfont: PDFFont, rfont: PDFFont) => {
    const r = S(right);
    const rw = r ? rfont.widthOfTextAtSize(r, size) : 0;
    const lines = wrap(S(left), lfont, size, CONTENT_W - rw - 10, CONTENT_W);
    if (!lines.length && !r) return;
    y += lh;
    if (r) text(r, MARGIN + CONTENT_W - rw, rfont, size);
    lines.forEach((l, i) => {
      if (i > 0) y += lh;
      text(l, MARGIN, lfont, size);
    });
  };
  const bullet = (t: string) => {
    const lines = wrap(S(t), f.reg, size, CONTENT_W - BULLET_INDENT, CONTENT_W - BULLET_INDENT);
    lines.forEach((l, i) => {
      y += lh;
      if (i === 0) text('\u2022', MARGIN + 3, f.reg, size);
      text(l, MARGIN + BULLET_INDENT, f.reg, size);
    });
  };
  const heading = (t: string) => {
    y += 5 + (size + 1) * 1.2;
    text(t.toUpperCase(), MARGIN, f.bold, size + 1);
    y += 2.5;
    ops.push({ k: 'rule', y });
    y += 1;
  };

  const h = doc.header;
  centered(S(h.name), f.bold, 16);
  y += 1;
  const contact = S(contactLine(h));
  if (contact) centered(contact, f.reg, size - 0.5);

  if (doc.education.length) {
    heading('Education');
    for (const e of doc.education) {
      row(e.school, e.dates, f.bold, f.reg);
      const sub = [e.degree, e.detail].filter(Boolean).join('. ');
      if (sub) for (const l of wrap(S(sub), f.ital, size, CONTENT_W, CONTENT_W)) { y += lh; text(l, MARGIN, f.ital, size); }
    }
  }

  if (doc.experience.length) {
    heading('Experience');
    doc.experience.forEach((e, i) => {
      row(e.org, e.dates, f.bold, f.reg);
      if (e.role || e.location) row(e.role, e.location, f.ital, f.ital);
      e.bullets.forEach((b, j) => !dropped.has(`e${i}.${j}`) && bullet(b.text));
      y += 2;
    });
  }

  if (doc.projects.length) {
    heading('Projects');
    doc.projects.forEach((p, i) => {
      row(p.name, p.dates, f.bold, f.reg);
      p.bullets.forEach((b, j) => !dropped.has(`p${i}.${j}`) && bullet(b.text));
      y += 2;
    });
  }

  if (doc.publications.length) {
    heading('Publications');
    for (const p of doc.publications) bullet(p);
  }

  if (doc.skills.length) {
    heading('Skills');
    for (const k of doc.skills) {
      const label = S(k.label) ? `${S(k.label)}: ` : '';
      const lw = label ? f.bold.widthOfTextAtSize(label, size) : 0;
      const lines = wrap(S(k.items), f.reg, size, CONTENT_W - lw, CONTENT_W);
      lines.forEach((l, i) => {
        y += lh;
        if (i === 0 && label) text(label, MARGIN, f.bold, size);
        text(l, MARGIN + (i === 0 ? lw : 0), f.reg, size);
      });
    }
  }

  return { ops, height: y + size * 0.3 };
}

function draw(page: PDFPage, ops: Op[]) {
  const top = PAGE_H - MARGIN;
  for (const op of ops) {
    const y = top - op.y;
    if (y < MARGIN - 2) continue; // last resort: never spill past the bottom margin
    if (op.k === 'rule') page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.6, color: rgb(0, 0, 0) });
    else if (op.text) page.drawText(op.text, { x: op.x, y, size: op.size, font: op.font, color: rgb(0, 0, 0) });
  }
}

export async function renderResumePdf(doc: ResumeDoc, o: { demo: boolean }): Promise<{ pdfBase64: string; pages: number; dropped: number }> {
  const d = maskForDemo(doc, o.demo);
  const pdf = await PDFDocument.create();
  pdf.setTitle(sanitizeWinAnsi(d.header.name ? `${d.header.name} resume` : 'Resume'));
  pdf.setProducer('Job Hunt OS');
  pdf.setCreator('Job Hunt OS');
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const charset = (font: PDFFont) => new Set(font.getCharacterSet());
  const a = charset(reg);
  const b = charset(bold);
  const c = charset(ital);
  const allowed = new Set([...a].filter((x) => b.has(x) && c.has(x)));
  const fonts: Fonts = { reg, bold, ital, allowed };
  const avail = PAGE_H - 2 * MARGIN;

  let size = BODY_SIZES[0];
  const dropped = new Set<string>();
  let out = layout(d, fonts, size, dropped);
  for (const s of BODY_SIZES.slice(1)) {
    if (out.height <= avail) break;
    size = s;
    out = layout(d, fonts, size, dropped);
  }
  while (out.height > avail) {
    const id = nextDrop(d, dropped);
    if (!id) break;
    dropped.add(id);
    out = layout(d, fonts, size, dropped);
  }

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  draw(page, out.ops);
  const bytes = await pdf.save();
  return { pdfBase64: Buffer.from(bytes).toString('base64'), pages: pdf.getPageCount(), dropped: dropped.size };
}

// ---------- print fallback ----------

const esc = (t: string) =>
  String(t ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Same content as the PDF, as a printable HTML page (Letter, 0.5 in margins). Used if the PDF renderer fails. */
export function resumeHtml(doc: ResumeDoc, o: { demo: boolean }): string {
  const d = maskForDemo(doc, o.demo);
  const row = (l: string, r: string, cls = 'b') => `<div class="row"><span class="${cls}">${esc(l)}</span><span>${esc(r)}</span></div>`;
  const ul = (items: string[]) => (items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
  const parts: string[] = [];
  parts.push(`<h1>${esc(d.header.name)}</h1><p class="contact">${esc(contactLine(d.header))}</p>`);
  if (d.education.length)
    parts.push(
      '<h2>Education</h2>' +
        d.education.map((e) => row(e.school, e.dates) + `<div class="i">${esc([e.degree, e.detail].filter(Boolean).join('. '))}</div>`).join('')
    );
  if (d.experience.length)
    parts.push(
      '<h2>Experience</h2>' +
        d.experience.map((e) => row(e.org, e.dates) + row(e.role, e.location, 'i') + ul(e.bullets.map((b) => b.text))).join('')
    );
  if (d.projects.length) parts.push('<h2>Projects</h2>' + d.projects.map((p) => row(p.name, p.dates) + ul(p.bullets.map((b) => b.text))).join(''));
  if (d.publications.length) parts.push('<h2>Publications</h2>' + ul(d.publications));
  if (d.skills.length)
    parts.push('<h2>Skills</h2>' + d.skills.map((k) => `<div>${k.label ? `<span class="b">${esc(k.label)}:</span> ` : ''}${esc(k.items)}</div>`).join(''));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.header.name || 'Resume')}</title>
<style>
@page { size: Letter; margin: 0.5in; }
body { font: 10pt/1.25 Helvetica, Arial, sans-serif; color: #000; background: #fff; max-width: 7.5in; margin: 0 auto; }
h1 { font-size: 16pt; text-align: center; margin: 0; }
.contact { text-align: center; font-size: 9.5pt; margin: 2px 0 4px; }
h2 { font-size: 11pt; text-transform: uppercase; border-bottom: 0.6pt solid #000; margin: 8px 0 2px; }
.row { display: flex; justify-content: space-between; gap: 10px; }
.b { font-weight: bold; } .i { font-style: italic; }
ul { margin: 0 0 3px; padding-left: 14px; } li { margin: 0; }
</style></head><body>
${parts.join('\n')}
</body></html>`;
}
