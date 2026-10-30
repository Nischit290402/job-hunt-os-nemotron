/** Loads $ENV_FILE, .env.demo, .env.local, then .env into process.env for scripts. Earlier files and existing variables win. */
import { existsSync, readFileSync } from 'node:fs';

for (const f of [process.env.ENV_FILE, '.env.demo', '.env.local', '.env'].filter((x): x is string => !!x)) {
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
