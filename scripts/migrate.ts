/** Applies migrations/*.sql in order, once each. Usage: npm run db:migrate */
import './_env';
import { readdirSync, readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const q = neon(url);
// Run one statement through the tagged-template interface (works across driver versions).
const run = (stmt: string) => q(Object.assign([stmt], { raw: [stmt] }) as unknown as TemplateStringsArray);

await run(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const done = new Set(((await run('SELECT name FROM schema_migrations')) as { name: string }[]).map((r) => r.name));
for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  const text = readFileSync(`migrations/${file}`, 'utf8').replace(/--.*$/gm, '');
  const statements = text.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await run(s);
  await q`INSERT INTO schema_migrations (name) VALUES (${file})`;
  console.log(`applied ${file} (${statements.length} statements)`);
}
console.log('migrations up to date');
