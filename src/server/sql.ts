/**
 * The one database interface the app uses: a tagged template returning rows.
 * Production: Neon's serverless driver (HTTP, works in Vercel functions). Tests: a psql-backed adapter.
 *
 * Conventions that keep both drivers identical:
 *  - date and timestamptz columns are always selected as ::text
 *  - JSON goes in as JSON.stringify(...) with an explicit ::jsonb cast
 *  - bytea goes in and out as base64 text (decode/encode in SQL)
 *  - bigint values are never read back as numbers
 */
export type Row = Record<string, any>;
export type Sql = <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

let cached: Sql | null = null;

export async function getSql(): Promise<Sql> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { neon } = await import('@neondatabase/serverless');
  const q = neon(url);
  cached = ((strings: TemplateStringsArray, ...values: unknown[]) => q(strings, ...values)) as Sql;
  return cached;
}
