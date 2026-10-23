/** Only same-site paths: "/x" is fine; "//evil.com" and "https://..." fall back to "/". */
export function safeBack(back: unknown): string {
  const b = String(back ?? '/');
  return b.startsWith('/') && !b.startsWith('//') && !b.startsWith('/\\') ? b : '/';
}
