/** Loads .env.local (then .env) into process.env for scripts. Existing variables win. */
import { existsSync, readFileSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    // Quoted values are taken as is; unquoted ones lose a trailing " # comment".
    const q = m[2].match(/^(['"])(.*)\1\s*(#.*)?$/);
    const v = q ? q[2] : m[2].replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
