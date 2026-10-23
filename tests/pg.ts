/**
 * Test-only Sql adapter over the psql CLI, so repository queries run against a real Postgres in CI and locally.
 * Values are inlined as SQL literals (safe here: test data only, never user input).
 * Set PGTEST_URL or PGHOST/PGPORT/PGUSER; the suite creates and drops its own database.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Sql } from '../src/server/sql';

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return lit(v.toISOString());
  if (Array.isArray(v)) {
    const inner = v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',');
    return lit(`{${inner}}`);
  }
  if (typeof v === 'object') return lit(JSON.stringify(v));
  return `'${String(v).replace(/'/g, "''")}'`;
};

function psql(db: string, sqlText: string): string {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sqlText], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\nSQL: ${sqlText.slice(0, 2000)}`);
  return r.stdout;
}

export function makeTestDb(): { sql: Sql; db: string; drop: () => void } {
  const base = process.env.PGTEST_DB || 'postgres';
  const db = `jh_test_${process.pid}_${Date.now()}`;
  psql(base, `CREATE DATABASE ${db}`);
  psql(db, readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let q = strings[0];
    values.forEach((v, i) => (q += lit(v) + strings[i + 1]));
    q = q.trim().replace(/;\s*$/, '');
    let wrapped: string | null = null;
    if (/^(select|with)\b/i.test(q)) wrapped = `SELECT coalesce(json_agg(t), '[]'::json) FROM (${q}) t`;
    else if (/\breturning\b/i.test(q)) wrapped = `WITH t AS (${q}) SELECT coalesce(json_agg(t), '[]'::json) FROM t`;
    if (!wrapped) {
      psql(db, q);
      return [];
    }
    const out = psql(db, wrapped).trim();
    return out ? JSON.parse(out) : [];
  }) as Sql;
  return { sql, db, drop: () => psql(base, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`) };
}

export function pgAvailable(): boolean {
  const r = spawnSync('psql', ['-X', '-At', '-d', process.env.PGTEST_DB || 'postgres', '-c', 'select 1'], { encoding: 'utf8', env: process.env });
  return r.status === 0;
}
