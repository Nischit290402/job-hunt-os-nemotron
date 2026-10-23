/** Minimal HTML to text for job descriptions. Good enough for a judge prompt; never used to render HTML. */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', hellip: '...', bull: '*', middot: '*', trade: '(TM)', reg: '(R)', copy: '(C)',
};

export function decodeEntities(s: string): string {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Greenhouse returns the description HTML-escaped, so callers may need decodeEntities twice; this handles both. */
export function htmlToText(html: string): string {
  let s = String(html ?? '');
  if (/&lt;[a-z/]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Caps text length for prompts while keeping whole lines where possible. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.8 ? cut.slice(0, nl) : cut) + '\n[truncated]';
}
