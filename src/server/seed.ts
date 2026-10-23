/** Loads sources, profile, preferences, caps and your past applications. Safe to run more than once. */
import type { Sql } from './sql';
import * as repo from './repo';
import type { SourceRow } from '../core/sources';
import { buildRules, evaluateJob, type RawJob } from '../core/filters';
import { DEFAULT_TERMS } from '../core/terms';

export interface SeedData {
  weekly_target: number;
  outreach_summary: string[];
  preferences: { kind: 'rule' | 'exclude_term' | 'archive_term'; text: string }[];
  caps: { company: string; cap: number }[];
  applied: { company: string; title: string; url: string; applied_on: string; track: 'sg' | 'remote' | 'ft' }[];
}

export async function seed(sql: Sql, sources: (SourceRow & { tier?: string; notes?: string })[], profileMd: string, data: SeedData) {
  for (const s of sources) await repo.upsertSource(sql, s);

  await repo.setProfile(sql, profileMd, data.outreach_summary.map((l) => `- ${l}`).join('\n'), data.weekly_target);

  const existing = await repo.listPreferences(sql);
  for (const p of data.preferences) {
    if (!existing.some((e) => e.kind === p.kind && e.text === p.text)) await repo.addPreference(sql, p.kind, p.text, 'seed');
  }
  for (const c of data.caps) await repo.setEmployerCap(sql, c.company, c.cap);

  const rules = buildRules(DEFAULT_TERMS);
  for (const a of data.applied) {
    const raw: RawJob = { company: a.company, title: a.title, location: 'Singapore', url: a.url, posted: '', channel: 'LIST' };
    const d = evaluateJob(raw, rules);
    const keep = d.action === 'keep' ? d : { action: 'keep' as const, track: a.track, family: 'ml', startWindow: '', hoursFlag: '', eligFlag: '' };
    const { jobId } = await repo.upsertJob(sql, raw, keep, null, a.applied_on);
    const r = await sql`INSERT INTO applications (user_id, job_id, state, picked_on, decided_at, applied_at, notes)
                        VALUES (${repo.USER}, ${jobId}, 'applied', ${a.applied_on}, ${a.applied_on}::date, ${a.applied_on}, 'imported from v0.3.1 tracker')
                        ON CONFLICT (user_id, job_id) DO NOTHING RETURNING id`;
    if (r.length) await repo.logEvent(sql, 'application', r[0].id, 'imported', 'you', { applied_on: a.applied_on });
  }
  return { sources: sources.length, preferences: data.preferences.length, applied: data.applied.length };
}
