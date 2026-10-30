/**
 * All database access. Every function takes the Sql handle first, so the same code runs on Neon and in tests.
 * Only applyEvent() changes applications.state, and it does so with an optimistic check on the previous state.
 */
import type { Sql } from './sql';
import type { Decision, RawJob } from '../core/filters';
import type { SourceRow } from '../core/sources';
import type { Candidate, EmployerInfo } from '../core/ranker';
import type { JudgeOutput } from '../core/judge';
import { canonicalKey, hash12, normCompany, xkey } from '../core/keys';
import { channelRank, DEFAULT_JOB_TYPES, type Channel, type JobType } from '../core/filters';
import { transition, type AppEvent, type AppState } from '../core/state';
import { addDays, weekStart } from '../core/time';
import { CLAIM_TTL_MIN, LAPTOP_AFTER_MIN, MAX_ATTEMPTS, TASK_KINDS, type TaskKind } from '../core/worker';

export const USER = 1;
const JD_OK_CHARS = 300;

// ---------- events and kv ----------

export async function logEvent(sql: Sql, entity: string, entityId: number | null, action: string, actor: 'system' | 'you', payload: object = {}) {
  await sql`INSERT INTO events (entity, entity_id, action, actor, payload) VALUES (${entity}, ${entityId}, ${action}, ${actor}, ${JSON.stringify(payload)}::jsonb)`;
}

export async function kvGet<T = unknown>(sql: Sql, key: string): Promise<T | null> {
  const r = await sql`SELECT value FROM kv WHERE key = ${key}`;
  return r.length ? (r[0].value as T) : null;
}

export async function kvSet(sql: Sql, key: string, value: unknown) {
  await sql`INSERT INTO kv (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const isPaused = async (sql: Sql) => (await kvGet<boolean>(sql, 'paused')) === true;

/** Which job types reach Today (/jobtypes). Default: internships and part-time. */
export async function jobTypes(sql: Sql): Promise<JobType[]> {
  return (await kvGet<JobType[]>(sql, 'job_types')) ?? DEFAULT_JOB_TYPES;
}

/** Atomic counter in kv; returns the new value. Concurrent callers each get a distinct number. */
export async function kvIncrement(sql: Sql, key: string): Promise<number> {
  const r = await sql`INSERT INTO kv (key, value) VALUES (${key}, '1'::jsonb)
                      ON CONFLICT (key) DO UPDATE SET
                        value = to_jsonb((CASE WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value)::text::int ELSE 0 END) + 1),
                        updated_at = now()
                      RETURNING value`;
  return Number(r[0].value);
}

/** True the first time an update id is seen. Telegram re-sends an update when it gets no 200 in time. */
export async function claimTelegramUpdate(sql: Sql, updateId: number): Promise<boolean> {
  const r = await sql`INSERT INTO kv (key, value) VALUES ('tg_last_update', to_jsonb(${updateId}::bigint))
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
                        WHERE jsonb_typeof(kv.value) <> 'number' OR (kv.value)::text::bigint < ${updateId}::bigint
                      RETURNING key`;
  return r.length === 1;
}

// ---------- sources ----------

export async function upsertSource(sql: Sql, s: SourceRow & { enabled?: boolean; tier?: string | null; notes?: string | null }) {
  await sql`INSERT INTO sources (id, type, company, slug_or_url, link_pattern, default_location, track_hint, tier, enabled, notes)
            VALUES (${s.id}, ${s.type}, ${s.company}, ${s.slug_or_url}, ${s.link_pattern ?? null}, ${s.default_location ?? null},
                    ${s.track_hint ?? null}, ${s.tier ?? null}, ${s.enabled ?? true}, ${s.notes ?? null})
            ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, company = EXCLUDED.company, slug_or_url = EXCLUDED.slug_or_url,
              link_pattern = EXCLUDED.link_pattern, default_location = EXCLUDED.default_location, track_hint = EXCLUDED.track_hint,
              tier = EXCLUDED.tier, notes = EXCLUDED.notes`;
}

export async function listSources(sql: Sql, onlyEnabled = true): Promise<(SourceRow & Record<string, any>)[]> {
  return onlyEnabled
    ? sql`SELECT id, type, company, slug_or_url, link_pattern, default_location, track_hint, enabled, last_status, last_count,
             last_ok_at::text AS last_ok_at, zero_runs FROM sources WHERE enabled ORDER BY id`
    : sql`SELECT id, type, company, slug_or_url, link_pattern, default_location, track_hint, enabled, last_status, last_count,
             last_ok_at::text AS last_ok_at, zero_runs FROM sources ORDER BY id`;
}

export async function getSource(sql: Sql, id: string) {
  const r = await sql`SELECT id, type, company, slug_or_url, link_pattern, default_location, track_hint, enabled FROM sources WHERE id = ${id}`;
  return (r[0] as SourceRow & { enabled: boolean }) ?? null;
}

export async function setSourceEnabled(sql: Sql, id: string, enabled: boolean) {
  await sql`UPDATE sources SET enabled = ${enabled} WHERE id = ${id}`;
}

export async function recordSourceResult(sql: Sql, id: string, status: string, count: number, ok: boolean) {
  await sql`UPDATE sources SET last_status = ${status}, last_count = ${count},
              last_ok_at = CASE WHEN ${ok} THEN now() ELSE last_ok_at END,
              zero_runs = CASE WHEN ${ok} AND ${count} = 0 THEN zero_runs + 1 WHEN ${ok} THEN 0 ELSE zero_runs END
            WHERE id = ${id}`;
}

// ---------- companies ----------

export async function upsertCompany(sql: Sql, name: string): Promise<number> {
  const key = normCompany(name) || `x${hash12(name)}`;
  const r = await sql`INSERT INTO companies (key, name) VALUES (${key}, ${name})
                      ON CONFLICT (key) DO UPDATE SET name = companies.name RETURNING id`;
  return r[0].id as number;
}

export async function setEmployerCap(sql: Sql, companyName: string, cap: number | null) {
  const id = await upsertCompany(sql, companyName);
  await sql`UPDATE companies SET employer_cap = ${cap} WHERE id = ${id}`;
}

// ---------- jobs ----------

export interface UpsertResult {
  jobId: number;
  isNew: boolean;
}

/**
 * Inserts a kept job or refreshes an existing one. Match order: canonical key, then an open job with the same
 * company + title + SG bucket (cross-channel postings that carry no ATS id). A more trusted channel takes over the URL.
 */
export async function upsertJob(sql: Sql, raw: RawJob, d: Extract<Decision, { action: 'keep' }>, sourceId: string | null, today: string): Promise<UpsertResult> {
  const key = canonicalKey(raw);
  const xk = xkey(raw);
  const jd = (raw.jdText || '').trim();
  const jdHash = jd.length >= JD_OK_CHARS ? hash12(jd) : null;
  let existing = await sql`SELECT id, channel, url, jd_status FROM jobs WHERE canonical_key = ${key}`;
  if (!existing.length) {
    existing = await sql`SELECT id, channel, url, jd_status FROM jobs WHERE xkey = ${xk} AND closed_at IS NULL ORDER BY id LIMIT 1`;
  }
  if (existing.length) {
    const e = existing[0];
    const better = channelRank(raw.channel) < channelRank(e.channel as Channel);
    await sql`UPDATE jobs SET last_seen = ${today}, missed_runs = 0, closed_at = NULL,
                url = CASE WHEN ${better} THEN ${raw.url} ELSE url END,
                channel = CASE WHEN ${better} THEN ${raw.channel} ELSE channel END,
                also_seen = CASE WHEN ${raw.channel} = channel OR ${raw.channel} = ANY(also_seen) THEN also_seen
                                 ELSE array_append(also_seen, ${raw.channel}) END,
                jd_text = CASE WHEN ${jdHash}::text IS NOT NULL AND jd_status <> 'ok' THEN ${jd} ELSE jd_text END,
                jd_hash = CASE WHEN ${jdHash}::text IS NOT NULL AND (jd_status <> 'ok' OR jd_hash IS DISTINCT FROM ${jdHash}) THEN ${jdHash} ELSE jd_hash END,
                jd_status = CASE WHEN ${jdHash}::text IS NOT NULL THEN 'ok' ELSE jd_status END,
                detail_ref = COALESCE(detail_ref, ${raw.detailRef ?? null})
              WHERE id = ${e.id}`;
    return { jobId: e.id as number, isNew: false };
  }
  const companyId = await upsertCompany(sql, raw.company || 'Unknown');
  const r = await sql`INSERT INTO jobs (canonical_key, xkey, company_id, company, title, location, url, channel, track, family,
                         start_window, hours_flag, elig_flag, posted, jd_text, jd_hash, jd_status, detail_ref, source_id, first_seen, last_seen)
                      VALUES (${key}, ${xk}, ${companyId}, ${raw.company || 'Unknown'}, ${raw.title}, ${raw.location || ''}, ${raw.url},
                         ${raw.channel}, ${d.track}, ${d.family}, ${d.startWindow}, ${d.hoursFlag}, ${d.eligFlag},
                         ${raw.posted || null}, ${jdHash ? jd : ''}, ${jdHash}, ${jdHash ? 'ok' : 'pending'}, ${raw.detailRef ?? null},
                         ${sourceId}, ${today}, ${today})
                      ON CONFLICT (canonical_key) DO UPDATE SET last_seen = EXCLUDED.last_seen
                      RETURNING id, (xmax = 0) AS inserted`;
  return { jobId: r[0].id as number, isNew: r[0].inserted === true };
}

/** Listings a source still shows but today's filters skip: jobs you already have for them (from /search) stay open. */
export async function touchListed(sql: Sql, sourceId: string, keys: string[], today: string): Promise<void> {
  await sql`UPDATE jobs SET last_seen = ${today}, missed_runs = 0
            WHERE source_id = ${sourceId} AND closed_at IS NULL
              AND canonical_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`;
}

/** A job missing twice in a row from a source that answered OK is closed. A failed fetch never closes anything. */
export async function markMissing(sql: Sql, sourceId: string, today: string): Promise<number> {
  const r = await sql`UPDATE jobs SET missed_runs = missed_runs + 1,
                        closed_at = CASE WHEN missed_runs + 1 >= 2 THEN ${today}::date ELSE closed_at END
                      WHERE source_id = ${sourceId} AND closed_at IS NULL AND last_seen < ${today}
                      RETURNING id, closed_at::text AS closed_at`;
  return r.filter((x) => x.closed_at).length;
}

export async function jobsNeedingJd(sql: Sql, limit: number) {
  return sql<{ id: number; url: string; detail_ref: string | null; channel: string }>`
    SELECT id, url, detail_ref, channel FROM jobs
    WHERE jd_status = 'pending' AND closed_at IS NULL AND track <> 'archive' ORDER BY first_seen DESC, id LIMIT ${limit}`;
}

export async function setJd(sql: Sql, jobId: number, text: string) {
  const t = text.trim();
  if (t.length >= JD_OK_CHARS) {
    await sql`UPDATE jobs SET jd_text = ${t}, jd_hash = ${hash12(t)}, jd_status = 'ok' WHERE id = ${jobId}`;
  } else {
    await sql`UPDATE jobs SET jd_status = 'unavailable' WHERE id = ${jobId}`;
  }
}

export interface JobToJudge {
  id: number;
  company: string;
  company_key: string;
  title: string;
  location: string;
  track: 'sg' | 'remote' | 'ft' | 'archive';
  start_window: string;
  hours_flag: string;
  elig_flag: string;
  jd_text: string;
  jd_hash: string | null;
}

/** Open jobs with no judgment for their current JD (new jobs, or the posting text changed). SG first, newest first. */
export async function jobsToJudge(sql: Sql, limit: number): Promise<JobToJudge[]> {
  return sql<JobToJudge>`
    SELECT j.id, j.company, c.key AS company_key, j.title, j.location, j.track, j.start_window, j.hours_flag, j.elig_flag, j.jd_text, j.jd_hash
    FROM jobs j JOIN companies c ON c.id = j.company_id
    LEFT JOIN latest_judgments lj ON lj.job_id = j.id
    WHERE j.closed_at IS NULL AND j.track <> 'archive' AND j.jd_status <> 'pending'
      AND (lj.id IS NULL OR lj.jd_hash IS DISTINCT FROM j.jd_hash)
    ORDER BY CASE j.track WHEN 'sg' THEN 0 WHEN 'remote' THEN 1 ELSE 2 END, j.first_seen DESC, j.id
    LIMIT ${limit}`;
}

export async function jobToJudgeById(sql: Sql, jobId: number): Promise<JobToJudge | null> {
  const r = await sql<JobToJudge>`
    SELECT j.id, j.company, c.key AS company_key, j.title, j.location, j.track, j.start_window, j.hours_flag, j.elig_flag, j.jd_text, j.jd_hash
    FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ${jobId}`;
  return r[0] ?? null;
}

/** Forces a re-judge of open, not-yet-decided jobs (used after preferences change). */
export async function requeueForJudging(sql: Sql) {
  await sql`DELETE FROM judgments WHERE job_id IN (
              SELECT j.id FROM jobs j LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
              WHERE j.closed_at IS NULL AND (a.id IS NULL OR a.state IN ('today','snoozed')))`;
}

export async function saveJudgment(sql: Sql, jobId: number, jdHash: string | null, o: JudgeOutput, model: string, rubricVersion: string) {
  await sql`INSERT INTO judgments (user_id, job_id, jd_hash, score, verdict, gates, flags, notes, deadline, rubric_version, model)
            VALUES (${USER}, ${jobId}, ${jdHash}, ${o.score}, ${o.verdict}, ${JSON.stringify(o.gates)}::jsonb, ${o.flags}::text[],
                    ${o.notes}, ${o.deadline}, ${rubricVersion}, ${model})`;
}

export async function getJob(sql: Sql, jobId: number) {
  const r = await sql`
    SELECT j.id, j.company, c.key AS company_key, j.title, j.location, j.url, j.channel, j.also_seen, j.track, j.family,
           j.start_window, j.hours_flag, j.elig_flag, j.posted::text AS posted, j.jd_text, j.jd_status,
           j.first_seen::text AS first_seen, j.closed_at::text AS closed_at,
           lj.score, lj.verdict, lj.notes, lj.flags, lj.gates, lj.deadline, lj.created_at::text AS judged_at
    FROM jobs j JOIN companies c ON c.id = j.company_id LEFT JOIN latest_judgments lj ON lj.job_id = j.id
    WHERE j.id = ${jobId}`;
  return r[0] ?? null;
}

// ---------- ranking ----------

export async function rankCandidates(sql: Sql): Promise<Candidate[]> {
  const rows = await sql`
    SELECT j.id AS "jobId", c.key AS "companyKey", j.company, j.title, j.track, j.hours_flag AS "hoursFlag", j.apply_route AS "applyRoute", lj.score, lj.verdict, lj.deadline,
           COALESCE(j.posted::text, '') AS posted, j.first_seen::text AS "firstSeen",
           a.state AS "appState", a.snooze_until::text AS "snoozeUntil"
    FROM jobs j JOIN companies c ON c.id = j.company_id
    JOIN latest_judgments lj ON lj.job_id = j.id
    LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
    WHERE j.closed_at IS NULL`;
  return rows.map((r) => ({ ...r, score: Number(r.score) })) as Candidate[];
}

const IN_FLIGHT: AppState[] = ['tailoring', 'finding_contact', 'awaiting_send', 'ask_sent', 'ready_to_fill', 'prefilled'];

export async function employerInfo(sql: Sql): Promise<Map<string, EmployerInfo>> {
  const rows = await sql`
    SELECT c.key, c.employer_cap AS cap,
           count(a.id) FILTER (WHERE a.state = ANY(${[...IN_FLIGHT, 'applied', 'interview']}::text[]))::int AS active,
           count(a.id) FILTER (WHERE a.state = ANY(${[...IN_FLIGHT, 'applied', 'interview', 'offer', 'rejected']}::text[]))::int AS used
    FROM companies c LEFT JOIN jobs j ON j.company_id = c.id
    LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
    GROUP BY c.key, c.employer_cap`;
  return new Map(rows.map((r) => [r.key as string, { active: Number(r.active), used: Number(r.used), cap: r.cap === null ? null : Number(r.cap) }]));
}

// ---------- applications ----------

export interface AppRow {
  id: number;
  job_id: number;
  state: AppState;
  snooze_count: number;
  snooze_until: string | null;
  picked_on: string;
  contact_id: number | null;
  referral_url: string | null;
  company: string;
  company_id: number;
  company_key: string;
  title: string;
  url: string; // the official apply link when one was found, else the listing URL
  listing_url: string;
  greenhouse_board: string | null; // the source's board token when the job came from a Greenhouse source
  apply_route: 'official' | 'email' | 'none' | null;
  apply_email: string | null;
  family: string;
  track: string;
  hours_flag: string | null;
  jd_text: string;
}

export async function getApplication(sql: Sql, id: number): Promise<AppRow | null> {
  const r = await sql<AppRow>`
    SELECT a.id, a.job_id, a.state, a.snooze_count, a.snooze_until::text AS snooze_until, a.picked_on::text AS picked_on,
           a.contact_id, a.referral_url, j.company, j.company_id, c.key AS company_key, j.title, COALESCE(j.apply_url, j.url) AS url,
           j.url AS listing_url, CASE WHEN s.type = 'greenhouse' THEN s.slug_or_url END AS greenhouse_board,
           j.apply_route, j.apply_email, j.family, j.track, j.hours_flag, j.jd_text
    FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id LEFT JOIN sources s ON s.id = j.source_id
    WHERE a.id = ${id} AND a.user_id = ${USER}`;
  return r[0] ?? null;
}

/** Puts a job into Today. Re-uses a snoozed application when one exists. Returns the application id. */
export async function putInToday(sql: Sql, jobId: number, today: string): Promise<number> {
  const r = await sql`
    INSERT INTO applications (user_id, job_id, state, picked_on) VALUES (${USER}, ${jobId}, 'today', ${today})
    ON CONFLICT (user_id, job_id) DO UPDATE SET state = 'today', picked_on = ${today}, updated_at = now()
      WHERE applications.state = 'snoozed'
    RETURNING id`;
  if (r.length) {
    await logEvent(sql, 'application', r[0].id, 'picked', 'system', { jobId, today });
    return r[0].id as number;
  }
  const e = await sql`SELECT id FROM applications WHERE user_id = ${USER} AND job_id = ${jobId}`;
  return e[0].id as number;
}

export class ConflictError extends Error {}

/**
 * The only writer of applications.state. Validates the move with the state machine, writes it only if the state is
 * still what was read (two taps on the same button cannot both win), and logs the event.
 */
export async function applyEvent(
  sql: Sql,
  appId: number,
  event: AppEvent,
  actor: 'system' | 'you',
  extra: { skipReason?: string; snoozeUntil?: string; contactId?: number; appliedAt?: string; note?: string } = {}
): Promise<AppState> {
  const cur = await sql`SELECT state, snooze_count FROM applications WHERE id = ${appId} AND user_id = ${USER}`;
  if (!cur.length) throw new Error(`application ${appId} not found`);
  const from = cur[0].state as AppState;
  const res = transition(from, event, { snoozeCount: Number(cur[0].snooze_count) });
  const snoozed = res.state === 'snoozed';
  const skipReason = res.state === 'skipped' ? extra.skipReason ?? res.note ?? null : null;
  const decided = event.startsWith('decide.');
  const upd = await sql`
    UPDATE applications SET state = ${res.state},
      snooze_count = snooze_count + ${snoozed ? 1 : 0},
      snooze_until = CASE WHEN ${snoozed} THEN ${extra.snoozeUntil ?? null}::date ELSE snooze_until END,
      skip_reason = COALESCE(${skipReason}, skip_reason),
      decided_at = CASE WHEN ${decided} THEN now() ELSE decided_at END,
      contact_id = COALESCE(${extra.contactId ?? null}, contact_id),
      applied_at = CASE WHEN ${res.state} = 'applied' THEN COALESCE(${extra.appliedAt ?? null}::date, CURRENT_DATE) ELSE applied_at END,
      outcome = CASE WHEN ${res.state} IN ('interview','offer','rejected') THEN ${res.state} ELSE outcome END,
      notes = COALESCE(${extra.note ?? null}, notes),
      updated_at = now()
    WHERE id = ${appId} AND state = ${from}
    RETURNING id`;
  if (!upd.length) throw new ConflictError(`application ${appId} changed state while handling ${event}`);
  await logEvent(sql, 'application', appId, event, actor, { from, to: res.state, ...extra, note: res.note ?? extra.note });
  return res.state;
}

export interface AppListRow {
  id: number;
  job_id: number;
  state: AppState;
  picked_on: string;
  snooze_until: string | null;
  updated_at: string;
  skip_reason: string | null;
  applied_at: string | null;
  company: string;
  title: string;
  url: string;
  family: string;
  track: string;
  score: number | null;
  verdict: string | null;
  notes: string | null;
  flags: string[] | null;
  deadline: string | null;
  apply_route: 'official' | 'email' | 'none' | null;
  apply_email: string | null;
}

export async function appsInStates(sql: Sql, states: AppState[]): Promise<AppListRow[]> {
  return sql<AppListRow>`
    SELECT a.id, a.job_id, a.state, a.picked_on::text AS picked_on, a.snooze_until::text AS snooze_until, a.updated_at::text AS updated_at,
           a.skip_reason, a.applied_at::text AS applied_at, j.company, j.title, COALESCE(j.apply_url, j.url) AS url, j.family, j.track,
           j.apply_route, j.apply_email, lj.score, lj.verdict, lj.notes, lj.flags, lj.deadline
    FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN latest_judgments lj ON lj.job_id = j.id
    WHERE a.user_id = ${USER} AND a.state = ANY(${states}::text[])
    ORDER BY a.updated_at DESC`;
}

/** Today items undecided for 3+ days are snoozed automatically (a second auto-snooze becomes a skip). */
export async function staleTodayIds(sql: Sql, today: string): Promise<number[]> {
  const r = await sql`SELECT id FROM applications WHERE user_id = ${USER} AND state = 'today' AND picked_on <= ${addDays(today, -3)}::date`;
  return r.map((x) => x.id as number);
}

export async function dueSnoozedIds(sql: Sql, today: string): Promise<number[]> {
  const r = await sql`SELECT id FROM applications WHERE user_id = ${USER} AND state = 'snoozed' AND snooze_until <= ${today}::date`;
  return r.map((x) => x.id as number);
}

export async function setReferralUrl(sql: Sql, appId: number, url: string) {
  await sql`UPDATE applications SET referral_url = ${url}, updated_at = now() WHERE id = ${appId}`;
}

// ---------- contacts ----------

export interface ContactInput {
  companyName: string;
  name: string;
  headline?: string;
  linkedinUrl?: string | null;
  email?: string | null;
  emailSource?: string | null;
  emailConfidence?: string | null;
  relation: 'connection' | 'alumni' | 'cold';
  kind: 'engineer' | 'recruiter';
  source: 'connections' | 'xray' | 'manual' | 'public_page';
  snippet?: string | null;
  today: string;
}

export async function upsertContact(sql: Sql, c: ContactInput): Promise<number> {
  const companyId = await upsertCompany(sql, c.companyName);
  if (c.linkedinUrl) {
    const r = await sql`
      INSERT INTO contacts (user_id, company_id, company, name, headline, linkedin_url, email, email_source, email_confidence, relation, kind, source, snippet, found_on)
      VALUES (${USER}, ${companyId}, ${c.companyName}, ${c.name}, ${c.headline ?? ''}, ${c.linkedinUrl}, ${c.email ?? null}, ${c.emailSource ?? null},
              ${c.emailConfidence ?? null}, ${c.relation}, ${c.kind}, ${c.source}, ${c.snippet ?? null}, ${c.today})
      ON CONFLICT (user_id, linkedin_url) WHERE linkedin_url IS NOT NULL DO UPDATE SET
        company_id = EXCLUDED.company_id, company = EXCLUDED.company, headline = EXCLUDED.headline,
        email = COALESCE(EXCLUDED.email, contacts.email), email_source = COALESCE(EXCLUDED.email_source, contacts.email_source),
        email_confidence = COALESCE(EXCLUDED.email_confidence, contacts.email_confidence),
        relation = CASE WHEN contacts.relation = 'connection' THEN 'connection' ELSE EXCLUDED.relation END,
        snippet = COALESCE(EXCLUDED.snippet, contacts.snippet), found_on = EXCLUDED.found_on
      RETURNING id`;
    return r[0].id as number;
  }
  const r = await sql`
    INSERT INTO contacts (user_id, company_id, company, name, headline, email, email_source, email_confidence, relation, kind, source, snippet, found_on)
    VALUES (${USER}, ${companyId}, ${c.companyName}, ${c.name}, ${c.headline ?? ''}, ${c.email ?? null}, ${c.emailSource ?? null},
            ${c.emailConfidence ?? null}, ${c.relation}, ${c.kind}, ${c.source}, ${c.snippet ?? null}, ${c.today})
    RETURNING id`;
  return r[0].id as number;
}

export interface ContactRow {
  id: number;
  name: string;
  headline: string;
  linkedin_url: string | null;
  email: string | null;
  email_confidence: string | null;
  relation: 'connection' | 'alumni' | 'cold';
  kind: 'engineer' | 'recruiter';
  source: string;
  found_on: string;
  last_contacted: string | null;
  do_not_contact: boolean;
}

export async function contactsAtCompany(sql: Sql, companyId: number): Promise<ContactRow[]> {
  return sql<ContactRow>`SELECT id, name, headline, linkedin_url, email, email_confidence, relation, kind, source, found_on::text AS found_on,
                    last_contacted::text AS last_contacted, do_not_contact
             FROM contacts WHERE user_id = ${USER} AND company_id = ${companyId} AND NOT do_not_contact
             ORDER BY CASE relation WHEN 'connection' THEN 0 WHEN 'alumni' THEN 1 ELSE 2 END,
                      CASE kind WHEN 'engineer' THEN 0 ELSE 1 END, found_on DESC`;
}

export async function setContactEmail(sql: Sql, id: number, email: string, source: string, confidence: string) {
  await sql`UPDATE contacts SET email = ${email}, email_source = ${source}, email_confidence = ${confidence} WHERE id = ${id} AND email IS NULL`;
}

export async function getContact(sql: Sql, id: number) {
  const r = await sql`SELECT id, company, name, headline, linkedin_url, email, email_confidence, relation, kind, do_not_contact
                      FROM contacts WHERE id = ${id} AND user_id = ${USER}`;
  return r[0] ?? null;
}

export async function connectionNamesByCompany(sql: Sql, companyKey: string, limit = 3): Promise<string[]> {
  const r = await sql`SELECT ct.name, ct.headline FROM contacts ct JOIN companies c ON c.id = ct.company_id
                      WHERE ct.user_id = ${USER} AND c.key = ${companyKey} AND ct.relation = 'connection' AND NOT ct.do_not_contact
                      ORDER BY ct.found_on DESC LIMIT ${limit}`;
  return r.map((x) => (x.headline ? `${x.name} (${x.headline})` : x.name));
}

export async function setDoNotContact(sql: Sql, email: string) {
  await sql`UPDATE contacts SET do_not_contact = true WHERE user_id = ${USER} AND lower(email) = ${email.toLowerCase()}`;
}

export async function doNotContactSet(sql: Sql): Promise<Set<string>> {
  const r = await sql`SELECT lower(email) AS email FROM contacts WHERE user_id = ${USER} AND do_not_contact AND email IS NOT NULL`;
  return new Set(r.map((x) => x.email as string));
}

/** Contacts with no interaction for 12 months are removed (PDPA/GDPR hygiene). */
export async function pruneOldContacts(sql: Sql, today: string): Promise<number> {
  const r = await sql`DELETE FROM contacts c WHERE c.user_id = ${USER} AND c.relation <> 'connection' AND NOT c.do_not_contact
                        AND COALESCE(c.last_contacted, c.found_on) < ${addDays(today, -365)}::date
                        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id)
                        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = c.id)
                      RETURNING id`;
  return r.length;
}

// ---------- messages ----------

export async function insertDraft(
  sql: Sql,
  m: { appId: number; contactId: number; kind: 'ask' | 'followup'; subject: string; body: string; linkedinNote: string; channel: 'email' | 'linkedin'; threadId?: string | null; inReplyTo?: string | null }
) {
  const r = await sql`INSERT INTO messages (user_id, application_id, contact_id, kind, subject, body, linkedin_note, channel, gmail_thread_id, in_reply_to)
                      VALUES (${USER}, ${m.appId}, ${m.contactId}, ${m.kind}, ${m.subject}, ${m.body}, ${m.linkedinNote}, ${m.channel}, ${m.threadId ?? null}, ${m.inReplyTo ?? null})
                      RETURNING id`;
  return r[0].id as number;
}

export async function latestDraft(sql: Sql, appId: number) {
  const r = await sql`
    SELECT m.id, m.kind, m.subject, m.body, m.linkedin_note, m.channel, m.status, m.gmail_thread_id, m.gmail_message_id, m.in_reply_to,
           ct.id AS contact_id, ct.name AS contact_name, ct.headline AS contact_headline, ct.email, ct.linkedin_url, ct.relation, ct.kind AS contact_kind
    FROM messages m JOIN contacts ct ON ct.id = m.contact_id
    WHERE m.application_id = ${appId} AND m.user_id = ${USER} AND m.status = 'draft'
    ORDER BY m.id DESC LIMIT 1`;
  return r[0] ?? null;
}

export async function updateDraftBody(sql: Sql, messageId: number, body: string) {
  await sql`UPDATE messages SET body = ${body} WHERE id = ${messageId} AND status = 'draft'`;
}

/** Claims a draft for sending. Only one caller can win, so a double tap cannot send twice. */
/**
 * Claims a draft so two taps act once. An email becomes 'gmail_draft' (saved to your Gmail drafts, sent by you from Gmail);
 * a LinkedIn note becomes 'sent' (you sent it yourself). sent_at is the hand-over time until Gmail shows the real one.
 */
export async function claimDraftForSend(sql: Sql, messageId: number, channel: 'email' | 'linkedin' = 'email'): Promise<boolean> {
  const next = channel === 'email' ? 'gmail_draft' : 'sent';
  const r = await sql`UPDATE messages SET status = ${next}, sent_at = now() WHERE id = ${messageId} AND status = 'draft' RETURNING id`;
  return r.length === 1;
}

export async function finalizeSent(sql: Sql, messageId: number, channel: 'email' | 'linkedin', gmail?: { id: string; threadId: string; draftId?: string }) {
  const r = await sql`UPDATE messages SET channel = ${channel}, gmail_message_id = ${gmail?.id ?? null}, gmail_draft_id = ${gmail?.draftId ?? null},
                        gmail_thread_id = COALESCE(${gmail?.threadId ?? null}, gmail_thread_id)
                      WHERE id = ${messageId} RETURNING contact_id`;
  if (r.length) await sql`UPDATE contacts SET last_contacted = CURRENT_DATE WHERE id = ${r[0].contact_id}`;
}

/** Emails saved to Gmail drafts that you have not sent yet. */
export async function gmailDraftsPending(sql: Sql) {
  return sql<{ id: number; application_id: number; gmail_thread_id: string; sent_at: string; contact_name: string; company: string }>`
    SELECT m.id, m.application_id, m.gmail_thread_id, m.sent_at::text AS sent_at, ct.name AS contact_name, j.company
    FROM messages m JOIN contacts ct ON ct.id = m.contact_id JOIN applications a ON a.id = m.application_id JOIN jobs j ON j.id = a.job_id
    WHERE m.user_id = ${USER} AND m.status = 'gmail_draft' AND m.gmail_thread_id IS NOT NULL`;
}

/** You sent the Gmail draft: record the real send time so the follow-up clock starts from it. */
export async function promoteGmailDraft(sql: Sql, messageId: number, sentAtIso: string) {
  await sql`UPDATE messages SET status = 'sent', sent_at = ${sentAtIso}::timestamptz WHERE id = ${messageId} AND status = 'gmail_draft'`;
}

/** Puts a claimed draft back when the send failed. */
export async function releaseDraft(sql: Sql, messageId: number) {
  await sql`UPDATE messages SET status = 'draft', sent_at = NULL WHERE id = ${messageId} AND status IN ('sent','gmail_draft') AND gmail_message_id IS NULL`;
}

export async function markMessageSent(sql: Sql, messageId: number, channel: 'email' | 'linkedin', gmail?: { id: string; threadId: string }) {
  const r = await sql`UPDATE messages SET status = 'sent', channel = ${channel}, sent_at = now(),
                        gmail_message_id = ${gmail?.id ?? null}, gmail_thread_id = ${gmail?.threadId ?? null}
                      WHERE id = ${messageId} AND status = 'draft' RETURNING contact_id`;
  if (r.length) await sql`UPDATE contacts SET last_contacted = CURRENT_DATE WHERE id = ${r[0].contact_id}`;
  return r.length > 0;
}

export async function markMessage(sql: Sql, messageId: number, status: 'replied' | 'dropped') {
  await sql`UPDATE messages SET status = ${status} WHERE id = ${messageId}`;
}

/** New asks sent today and this week (follow-ups excluded), Singapore calendar. */
export async function sendCounts(sql: Sql, today: string): Promise<{ today: number; week: number }> {
  const ws = weekStart(today);
  const r = await sql`
    SELECT count(*) FILTER (WHERE (sent_at AT TIME ZONE 'Asia/Singapore')::date = ${today}::date)::int AS today,
           count(*) FILTER (WHERE (sent_at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date)::int AS week
    FROM messages WHERE user_id = ${USER} AND kind = 'ask' AND channel = 'email' AND status IN ('gmail_draft','sent','replied')`;
  return { today: Number(r[0].today), week: Number(r[0].week) };
}

export interface AwaitingReplyRow {
  id: number;
  application_id: number;
  kind: string;
  subject: string;
  gmail_thread_id: string;
  sent_at: string;
  contact_id: number;
  contact_name: string;
  email: string | null;
  title: string;
  state: AppState;
  followups: number;
}

export async function sentEmailsAwaitingReply(sql: Sql): Promise<AwaitingReplyRow[]> {
  return sql<AwaitingReplyRow>`
    SELECT m.id, m.application_id, m.kind, m.subject, m.gmail_thread_id, m.sent_at::text AS sent_at, ct.id AS contact_id, ct.name AS contact_name, ct.email,
           j.title, a.state,
           (SELECT count(*)::int FROM messages f WHERE f.application_id = m.application_id AND f.kind = 'followup') AS followups
    FROM messages m JOIN contacts ct ON ct.id = m.contact_id JOIN applications a ON a.id = m.application_id JOIN jobs j ON j.id = a.job_id
    WHERE m.user_id = ${USER} AND m.kind = 'ask' AND m.status = 'sent' AND m.channel = 'email' AND m.gmail_thread_id IS NOT NULL`;
}

// ---------- resumes ----------

export async function saveResume(sql: Sql, appId: number, r: { tex: string; pdfBase64: string; summary: string; verifyPassed: boolean | null; verifyOutput: string }) {
  const out = await sql`INSERT INTO resume_versions (user_id, application_id, tex, pdf, summary, verify_passed, verify_output)
                        VALUES (${USER}, ${appId}, ${r.tex}, decode(${r.pdfBase64}, 'base64'), ${r.summary}, ${r.verifyPassed}, ${r.verifyOutput})
                        RETURNING id`;
  return out[0].id as number;
}

export async function latestResume(sql: Sql, appId: number) {
  const r = await sql`SELECT id, encode(pdf, 'base64') AS pdf_base64, summary, verify_passed, created_at::text AS created_at
                      FROM resume_versions WHERE application_id = ${appId} AND user_id = ${USER} ORDER BY id DESC LIMIT 1`;
  return r[0] ?? null;
}

// ---------- profile and preferences ----------

export async function getProfile(sql: Sql) {
  const r = await sql`SELECT body, outreach_summary, weekly_target FROM profile WHERE user_id = ${USER}`;
  return (r[0] as { body: string; outreach_summary: string; weekly_target: number }) ?? { body: '', outreach_summary: '', weekly_target: 5 };
}

export async function setProfile(sql: Sql, body: string, outreachSummary: string, weeklyTarget = 5) {
  await sql`INSERT INTO profile (user_id, body, outreach_summary, weekly_target) VALUES (${USER}, ${body}, ${outreachSummary}, ${weeklyTarget})
            ON CONFLICT (user_id) DO UPDATE SET body = EXCLUDED.body, outreach_summary = EXCLUDED.outreach_summary,
              weekly_target = EXCLUDED.weekly_target, updated_at = now()`;
}

export async function listPreferences(sql: Sql, activeOnly = true) {
  return activeOnly
    ? sql`SELECT id, kind, text, source, created_at::text AS created_at FROM preferences WHERE user_id = ${USER} AND active ORDER BY id`
    : sql`SELECT id, kind, text, source, active, created_at::text AS created_at FROM preferences WHERE user_id = ${USER} ORDER BY id`;
}

export async function addPreference(sql: Sql, kind: 'rule' | 'exclude_term' | 'archive_term' | 'skip_feedback', text: string, source = 'you') {
  const r = await sql`INSERT INTO preferences (user_id, kind, text, source) VALUES (${USER}, ${kind}, ${text}, ${source}) RETURNING id`;
  return r[0].id as number;
}

export async function deactivatePreference(sql: Sql, id: number) {
  const r = await sql`UPDATE preferences SET active = false WHERE id = ${id} AND user_id = ${USER} RETURNING id`;
  return r.length > 0;
}

/** Preferences split by kind for the judge prompt and the collector's term lists. */
export async function preferenceBundle(sql: Sql) {
  const rows = await listPreferences(sql);
  const by = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.text as string);
  return { rules: by('rule'), exclude: by('exclude_term'), archive: by('archive_term'), skips: by('skip_feedback').slice(-20) };
}

// ---------- runs, health, stats ----------

export async function recordRun(sql: Sql, r: { step: string; sourceId?: string | null; seconds: number; ok: boolean; error?: string | null; detail?: object; tokensIn?: number; tokensOut?: number; credits?: number }) {
  await sql`INSERT INTO runs (step, source_id, seconds, ok, error, detail, tokens_in, tokens_out, credits)
            VALUES (${r.step}, ${r.sourceId ?? null}, ${r.seconds}, ${r.ok}, ${r.error ?? null}, ${JSON.stringify(r.detail ?? {})}::jsonb,
                    ${r.tokensIn ?? 0}, ${r.tokensOut ?? 0}, ${r.credits ?? 0})`;
}

export async function firecrawlCredits(sql: Sql, today: string) {
  const r = await sql`
    SELECT COALESCE(sum(credits) FILTER (WHERE (started_at AT TIME ZONE 'Asia/Singapore')::date = ${today}::date), 0)::int AS today,
           COALESCE(sum(credits) FILTER (WHERE date_trunc('month', started_at AT TIME ZONE 'Asia/Singapore') = date_trunc('month', ${today}::date)), 0)::int AS month,
           COALESCE(sum(credits), 0)::int AS total
    FROM runs`;
  return { today: Number(r[0].today), month: Number(r[0].month), total: Number(r[0].total) };
}

export async function tokensThisMonth(sql: Sql, today: string) {
  const r = await sql`SELECT COALESCE(sum(tokens_in), 0)::int AS tin, COALESCE(sum(tokens_out), 0)::int AS tout FROM runs
                      WHERE date_trunc('month', started_at AT TIME ZONE 'Asia/Singapore') = date_trunc('month', ${today}::date)`;
  return { in: Number(r[0].tin), out: Number(r[0].tout) };
}

export async function healthSummary(sql: Sql, today: string) {
  const src = await sql`SELECT count(*)::int AS total,
                               count(*) FILTER (WHERE (last_ok_at AT TIME ZONE 'Asia/Singapore')::date = ${today}::date)::int AS ok
                        FROM sources WHERE enabled`;
  const runs = await sql`SELECT count(*) FILTER (WHERE NOT ok)::int AS failed,
                                count(*) FILTER (WHERE ok AND step = 'judge')::int AS judge_runs,
                                COALESCE(sum((detail->>'judged')::int) FILTER (WHERE step = 'judge'), 0)::int AS judged,
                                max(started_at) FILTER (WHERE step = 'judge')::text AS last_judge,
                                COALESCE(sum(credits), 0)::int AS credits
                         FROM runs WHERE (started_at AT TIME ZONE 'Asia/Singapore')::date = ${today}::date`;
  return {
    sourcesOk: Number(src[0].ok),
    sourcesTotal: Number(src[0].total),
    failedSteps: Number(runs[0].failed),
    judgedToday: Number(runs[0].judged),
    lastJudgeAt: (runs[0].last_judge as string) ?? null,
    firecrawlToday: Number(runs[0].credits),
  };
}

export async function weekStats(sql: Sql, today: string) {
  const ws = weekStart(today);
  const a = await sql`SELECT count(*)::int AS n FROM applications WHERE user_id = ${USER} AND applied_at >= ${ws}::date`;
  const m = await sql`SELECT count(*)::int AS n FROM messages WHERE user_id = ${USER} AND kind = 'ask' AND status IN ('sent','replied')
                      AND (sent_at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date`;
  const p = await getProfile(sql);
  return { applied: Number(a[0].n), referralsSent: Number(m[0].n), target: p.weekly_target };
}

/** Funnel for the Sunday review: what came in, what you decided, what went out, what came back. */
export async function weeklyFunnel(sql: Sql, today: string) {
  const ws = weekStart(today);
  const r = await sql`
    SELECT
      (SELECT count(*)::int FROM jobs WHERE first_seen >= ${ws}::date) AS listed,
      (SELECT count(*)::int FROM judgments WHERE (created_at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date) AS judged,
      (SELECT count(*)::int FROM applications WHERE picked_on >= ${ws}::date) AS shown,
      (SELECT count(*)::int FROM events WHERE action = 'decide.apply' AND (at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date) AS apply_taps,
      (SELECT count(*)::int FROM events WHERE action = 'decide.skip' AND (at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date) AS skips,
      (SELECT count(*)::int FROM applications WHERE applied_at >= ${ws}::date) AS applied,
      (SELECT count(*)::int FROM messages WHERE kind = 'ask' AND (sent_at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date) AS asks,
      (SELECT count(*)::int FROM messages WHERE status = 'replied' AND (sent_at AT TIME ZONE 'Asia/Singapore')::date >= ${ws}::date) AS replies,
      (SELECT count(*)::int FROM applications WHERE state = 'interview') AS interviews`;
  return r[0] as Record<string, number>;
}

export async function rejectSample(sql: Sql, today: string, n = 20) {
  const r = await sql`SELECT detail->'rejected_sample' AS s, source_id FROM runs
                      WHERE step = 'collect' AND (started_at AT TIME ZONE 'Asia/Singapore')::date >= ${addDays(today, -7)}::date`;
  const all: { title: string; reason: string; source: string }[] = [];
  for (const row of r) for (const x of (row.s as any[]) ?? []) all.push({ ...x, source: row.source_id });
  // Deterministic pseudo-random pick so the same week shows the same sample.
  return all.sort((a, b) => hash12(a.title).localeCompare(hash12(b.title))).slice(0, n);
}

// ---------- dashboard views ----------

export async function appForJob(sql: Sql, jobId: number) {
  const r = await sql`SELECT id, state, skip_reason, snooze_until::text AS snooze_until, applied_at::text AS applied_at, referral_url, contact_id
                      FROM applications WHERE user_id = ${USER} AND job_id = ${jobId}`;
  return r[0] ?? null;
}

export async function eventsFor(sql: Sql, entity: string, id: number, limit = 50) {
  return sql`SELECT action, actor, payload, at::text AS at FROM events WHERE entity = ${entity} AND entity_id = ${id} ORDER BY at DESC LIMIT ${limit}`;
}

export async function messagesForApp(sql: Sql, appId: number) {
  return sql`SELECT m.id, m.kind, m.subject, m.body, m.linkedin_note, m.status, m.channel, m.sent_at::text AS sent_at, ct.name AS contact_name, ct.email
             FROM messages m JOIN contacts ct ON ct.id = m.contact_id WHERE m.application_id = ${appId} ORDER BY m.id DESC`;
}

export async function peopleOverview(sql: Sql, limit = 300) {
  return sql`SELECT ct.id, ct.name, ct.headline, ct.company, ct.relation, ct.kind, ct.source, ct.linkedin_url, ct.email, ct.do_not_contact,
                    ct.found_on::text AS found_on, ct.last_contacted::text AS last_contacted,
                    (SELECT count(*)::int FROM messages m WHERE m.contact_id = ct.id AND m.status IN ('sent','replied')) AS sent,
                    (SELECT count(*)::int FROM messages m WHERE m.contact_id = ct.id AND m.status = 'replied') AS replied
             FROM contacts ct WHERE ct.user_id = ${USER}
             ORDER BY (SELECT count(*) FROM messages m WHERE m.contact_id = ct.id) DESC, ct.last_contacted DESC NULLS LAST, ct.company, ct.name
             LIMIT ${limit}`;
}

export async function employerCaps(sql: Sql) {
  return sql`SELECT c.name, c.employer_cap,
                    (SELECT count(*)::int FROM applications a JOIN jobs j ON j.id = a.job_id
                     WHERE j.company_id = c.id AND a.state NOT IN ('today','snoozed','skipped')) AS used
             FROM companies c WHERE c.employer_cap IS NOT NULL ORDER BY c.name`;
}

export async function recentRuns(sql: Sql, limit = 40) {
  return sql`SELECT step, source_id, started_at::text AS started_at, seconds::float AS seconds, ok, error, credits, tokens_in, tokens_out
             FROM runs ORDER BY started_at DESC LIMIT ${limit}`;
}

// ---------- login codes ----------

export async function storeLoginCode(sql: Sql, codeHash: string, ttlSeconds: number) {
  await sql`DELETE FROM login_codes WHERE expires_at < now() OR used`;
  await sql`UPDATE login_codes SET used = true WHERE NOT used`; // only the newest code is ever valid
  await sql`INSERT INTO login_codes (code_hash, expires_at) VALUES (${codeHash}, now() + make_interval(secs => ${ttlSeconds}))`;
}

export async function invalidateLoginCodes(sql: Sql) {
  await sql`UPDATE login_codes SET used = true WHERE NOT used`;
}

export async function consumeLoginCode(sql: Sql, codeHash: string): Promise<boolean> {
  const r = await sql`UPDATE login_codes SET used = true WHERE code_hash = ${codeHash} AND NOT used AND expires_at > now() RETURNING code_hash`;
  return r.length === 1;
}

// ---------- Claude work queue (worker_tasks) ----------

export interface ClaimedTask {
  id: number;
  kind: TaskKind;
  ref: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Queues one piece of work. Returns null when the same work is already open. */
export async function enqueueTask(sql: Sql, kind: TaskKind, ref: string, payload: object): Promise<number | null> {
  const r = await sql`INSERT INTO worker_tasks (kind, ref, payload) VALUES (${kind}, ${ref}, ${JSON.stringify(payload)}::jsonb)
                      ON CONFLICT (kind, ref) WHERE status IN ('queued','claimed') DO NOTHING RETURNING id`;
  return r.length ? Number(r[0].id) : null;
}

export async function dropTaskImages(sql: Sql, id: number) {
  await sql`UPDATE worker_tasks SET payload = payload - 'images' WHERE id = ${id}`;
}

/** Hands out up to `limit` tasks, most urgent kind first. A claim older than CLAIM_TTL_MIN is handed out again. */
export async function claimTasks(sql: Sql, runner: string, limit: number, kind?: TaskKind): Promise<ClaimedTask[]> {
  const r = await sql`UPDATE worker_tasks SET status = 'claimed', claimed_by = ${runner}, claimed_at = now(), attempts = attempts + 1
                      WHERE id IN (
                        SELECT id FROM worker_tasks
                        WHERE (status = 'queued' OR (status = 'claimed' AND claimed_at < now() - make_interval(mins => ${CLAIM_TTL_MIN})))
                          AND attempts < ${MAX_ATTEMPTS} AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
                        ORDER BY CASE kind WHEN 'coach' THEN 0 WHEN 'answers' THEN 1 WHEN 'lead' THEN 2 WHEN 'tailor' THEN 3 WHEN 'draft' THEN 4 ELSE 5 END, id
                        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
                      RETURNING id, kind, ref, payload, attempts`;
  const rank = (k: string) => TASK_KINDS.indexOf(k as TaskKind); // UPDATE ... RETURNING does not keep the subquery's order
  return r
    .map((x) => ({ id: Number(x.id), kind: x.kind as TaskKind, ref: x.ref as string, payload: x.payload as Record<string, unknown>, attempts: Number(x.attempts) }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.id - b.id);
}

/** Marks a claimed task done. Returns the task, or null when it was not claimed (late or duplicate result). */
export async function completeTask(sql: Sql, id: number, result: object): Promise<ClaimedTask | null> {
  const r = await sql`UPDATE worker_tasks SET status = 'done', result = ${JSON.stringify(result)}::jsonb, done_at = now(), error = NULL
                      WHERE id = ${id} AND status = 'claimed' RETURNING id, kind, ref, payload, attempts`;
  return r.length ? { id: Number(r[0].id), kind: r[0].kind as TaskKind, ref: r[0].ref as string, payload: r[0].payload as Record<string, unknown>, attempts: Number(r[0].attempts) } : null;
}

/** Puts a task back in the queue, or fails it for good after MAX_ATTEMPTS. Returns the new status. */
export async function failTask(sql: Sql, id: number, error: string): Promise<{ status: string; kind: TaskKind; ref: string; payload: Record<string, unknown> } | null> {
  const r = await sql`UPDATE worker_tasks SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
                        error = ${error.slice(0, 1000)}, claimed_by = NULL, claimed_at = NULL,
                        done_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END
                      WHERE id = ${id} AND status = 'claimed' RETURNING status, kind, ref, payload`;
  return r.length ? { status: r[0].status as string, kind: r[0].kind as TaskKind, ref: r[0].ref as string, payload: r[0].payload as Record<string, unknown> } : null;
}

/** Open work by kind, and how much of it nobody has picked up for `olderThanMin` minutes. */
export async function queueSummary(sql: Sql, olderThanMin = LAPTOP_AFTER_MIN): Promise<{ open: Record<string, number>; stale: number }> {
  const r = await sql`SELECT kind, count(*)::int AS n,
                             count(*) FILTER (WHERE status = 'queued' AND created_at < now() - make_interval(mins => ${olderThanMin}))::int AS stale
                      FROM worker_tasks WHERE status IN ('queued','claimed') GROUP BY kind`;
  const open: Record<string, number> = {};
  let stale = 0;
  for (const x of r) {
    open[x.kind as string] = Number(x.n);
    stale += Number(x.stale);
  }
  return { open, stale };
}

/** Fails open tasks that have used every attempt, so their callers can move on. */
export async function expireExhaustedTasks(sql: Sql) {
  const r = await sql`UPDATE worker_tasks SET status = 'failed', done_at = now(), error = coalesce(error, 'abandoned after ' || attempts || ' attempts')
                      WHERE status = 'claimed' AND attempts >= ${MAX_ATTEMPTS} AND claimed_at < now() - make_interval(mins => ${CLAIM_TTL_MIN})
                      RETURNING id, kind, ref`;
  return r.map((x) => ({ id: Number(x.id), kind: x.kind as TaskKind, ref: x.ref as string }));
}

export async function workerWeek(sql: Sql, today: string) {
  const r = await sql`SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'failed')::int AS failed
                      FROM worker_tasks WHERE done_at >= ${addDays(today, -7)}::date`;
  return { done: Number(r[0]?.done ?? 0), failed: Number(r[0]?.failed ?? 0) };
}

// ---------- apply routes ----------

/** MyCareersFuture and aggregator jobs worth showing whose official route has not been looked up yet, best first. */
export async function jobsNeedingRoute(sql: Sql, channels: string[], limit: number) {
  return sql<{ id: number; company: string; title: string; jd_text: string | null }>`
    SELECT j.id, j.company, j.title, j.jd_text
    FROM jobs j JOIN latest_judgments lj ON lj.job_id = j.id
    LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
    WHERE j.closed_at IS NULL AND j.channel = ANY(${channels}::text[]) AND j.apply_route IS NULL
      AND (a.id IS NULL OR a.state IN ('today','snoozed','tailoring','finding_contact','awaiting_send','ask_sent','ready_to_fill','prefilled'))
      AND (a.id IS NOT NULL OR (lj.verdict <> 'Skip' AND lj.score >= 55))
    ORDER BY (a.id IS NOT NULL) DESC, lj.score DESC, j.id
    LIMIT ${limit}`;
}

export async function setRoute(sql: Sql, jobId: number, route: 'official' | 'email' | 'none', applyUrl: string | null, applyEmail: string | null) {
  await sql`UPDATE jobs SET apply_route = ${route}, apply_url = ${applyUrl}, apply_email = ${applyEmail}, route_checked_at = now() WHERE id = ${jobId}`;
}

/** The newest answers task for an application: its status and, when done, the drafted answers. */
export async function latestAnswers(sql: Sql, appId: number) {
  const r = await sql`SELECT status, result FROM worker_tasks WHERE kind = 'answers' AND ref = ${`app:${appId}`} ORDER BY id DESC LIMIT 1`;
  return (r[0] as { status: string; result: { output?: { answers?: { qid: string; text: string }[] } } | null }) ?? null;
}
