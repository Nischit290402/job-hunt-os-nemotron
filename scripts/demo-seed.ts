/**
 * Prepares the demo database from your laptop: stores your master resume and runs the daily Nemotron pass once.
 * Usage: npm run demo:seed -- --master "<path to Master Resume MD.md>" --yes [--no-daily]
 * Reads .env.demo first (scripts/_env.ts), so DATABASE_URL should point at the demo branch.
 */
import './_env';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { getSql } from '../src/server/sql';
import * as repo from '../src/server/repo';
import { MASTER_MAX_CHARS, type MasterCopy } from '../src/core/master';
import { sgtDate } from '../src/core/time';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Put it in .env.demo.');
  process.exit(1);
}
// Print only the host so the password never reaches the terminal log.
let host = '(unparseable URL)';
try {
  host = new URL(url).host;
} catch {}
console.log(`Database host: ${host}`);

if (!flag('--yes')) {
  console.error('This writes to the database above. Re-run with --yes to continue.');
  process.exit(1);
}

const masterPath = value('--master');
if (!masterPath) {
  console.error('Missing --master "<path to your master resume markdown>".');
  process.exit(1);
}
const vault = readFileSync(masterPath, 'utf8');
if (vault.length < 500 || vault.length > MASTER_MAX_CHARS) {
  console.error(`Master resume must be 500 to ${MASTER_MAX_CHARS} characters; this file has ${vault.length}.`);
  process.exit(1);
}

const sql = await getSql();
const modified = statSync(masterPath).mtime.toISOString();
// One file serves as both copies, so the two timestamps match and no drift warning fires.
const master: MasterCopy = {
  vault,
  tagged: vault,
  vaultModified: modified,
  taggedModified: modified,
  files: {},
  sha: createHash('sha256').update(vault).digest('hex'),
  syncedAt: new Date().toISOString(),
};
await repo.kvSet(sql, 'master_resume', master);
console.log(`Master resume stored (${vault.length} chars, sha ${master.sha.slice(0, 12)}).`);

if (flag('--no-daily')) {
  console.log('Skipped the daily run (--no-daily).');
  process.exit(0);
}

const today = sgtDate();
const startedAt = new Date().toISOString();
// Non-literal dynamic import: typecheck does not bind this script to the daily module's exact exports.
const dailyModule = '../src/server/nemotron/daily';
const m: any = await import(dailyModule);
if (typeof m.runDaily !== 'function') throw new Error('runDaily not found in src/server/nemotron/daily');
const summary = await m.runDaily(sql, today, { sources: 6, triage: 10, rejudge: 2, deadlineMs: Date.now() + 280_000 });
console.log('Daily run summary:');
console.log(JSON.stringify(summary, null, 2));

const [spend] = await sql`
  SELECT COALESCE(sum((detail->>'costUsd')::numeric) FILTER (WHERE started_at >= ${startedAt}::timestamptz), 0)::float8 AS run,
         COALESCE(sum((detail->>'costUsd')::numeric), 0)::float8 AS total
  FROM runs WHERE step LIKE 'llm:%'`;
console.log(`LLM spend: this run $${Number(spend.run).toFixed(4)}, all time $${Number(spend.total).toFixed(4)}`);
