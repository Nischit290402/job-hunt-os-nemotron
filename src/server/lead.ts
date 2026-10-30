/**
 * Leads you add from Telegram (/lead). Creates the job, gets the description (what you pasted, else the careers link,
 * never LinkedIn), stores the person you named as the preferred contact, puts it in Today and queues judging.
 * The card arrives once the worker has scored it.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { env } from './env';
import { httpGet } from './http';
import { scrape } from './firecrawl';
import { fire, queueJudgeJob, queueLeadShots, sendLeadCard } from './worker';
import * as tg from './telegram';
import { escapeHtml } from '../core/brief';
import { buildRules, evaluateJob, familyOf, type Decision, type RawJob } from '../core/filters';
import { DEFAULT_TERMS, withExtraTerms } from '../core/terms';
import { hash12 } from '../core/keys';
import { htmlToText } from '../core/html';
import { isLinkedInUrl, leadUrl, type Lead } from '../core/lead';

const JD_MIN = 300;

export const leadContactKey = (appId: number) => `lead_contact:${appId}`;

async function fetchDescription(sql: Sql, link: string, today: string): Promise<{ text: string; how: string }> {
  if (!link || isLinkedInUrl(link)) return { text: '', how: link ? 'LinkedIn links are never opened' : 'no link' };
  const r = await httpGet(link, {}, 15_000);
  let text = r.status === 200 ? htmlToText(r.text) : '';
  if (text.length >= JD_MIN) return { text, how: 'from the careers page' };
  if (env.firecrawlKey()) {
    const fc = await scrape(sql, link, today);
    if (fc.state === 'ok') text = htmlToText(fc.markdown);
    if (text.length >= JD_MIN) return { text, how: 'from the careers page (Firecrawl)' };
  }
  return { text: '', how: `the link gave no readable description${r.status && r.status !== 200 ? ` (HTTP ${r.status})` : ''}` };
}

export async function createLead(sql: Sql, lead: Lead, today: string, now = Date.now(), from: 'typed' | 'screenshot' = 'typed') {
  const url = leadUrl(lead, hash12);
  const raw: RawJob = {
    company: lead.company, title: lead.role, location: 'Singapore', url, posted: today,
    channel: url.startsWith('https://lead.jobhunt.local/') ? 'LEAD' : 'ATS',
  };
  // You chose this one yourself, so the usual filters only classify it; they never reject it.
  const prefs = await repo.preferenceBundle(sql);
  const d = evaluateJob(raw, buildRules(withExtraTerms(DEFAULT_TERMS, { exclude: prefs.exclude, archive: prefs.archive })), now);
  const keep: Extract<Decision, { action: 'keep' }> =
    d.action === 'keep' ? { ...d, track: d.track === 'archive' ? 'sg' : d.track } : { action: 'keep', track: 'sg', family: familyOf(lead.role), startWindow: '', hoursFlag: '', eligFlag: '' };
  const { jobId } = await repo.upsertJob(sql, raw, keep, null, today);

  let jd = lead.jd.trim();
  let how = jd.length >= JD_MIN ? (from === 'screenshot' ? 'read from your screenshots' : 'as you pasted it') : '';
  if (jd.length < JD_MIN) {
    const f = await fetchDescription(sql, lead.link, today);
    if (f.text) [jd, how] = [f.text, f.how];
    else how = jd ? 'your pasted text is short' : f.how;
  }
  await repo.setJd(sql, jobId, jd);

  const appId = await repo.putInToday(sql, jobId, today);
  let contactNote = '';
  if (lead.person) {
    const contactId = await repo.upsertContact(sql, {
      companyName: lead.company, name: lead.person, headline: `posted about ${lead.role}`.slice(0, 120), linkedinUrl: null,
      relation: 'cold', kind: 'engineer', source: 'manual', snippet: 'Added by you with /lead', today,
    });
    await repo.kvSet(sql, leadContactKey(appId), contactId);
    contactNote = ` ${lead.person} is the contact if you apply.`;
  }

  const job = await repo.jobToJudgeById(sql, jobId);
  const already = (await sql`SELECT 1 FROM latest_judgments WHERE job_id = ${jobId} AND jd_hash IS NOT DISTINCT FROM ${job?.jd_hash ?? null}`).length > 0;
  // Without a description the score would be capped and meaningless: wait for the JD you reply with.
  const queued = job && !already && jd.length >= JD_MIN ? await queueJudgeJob(sql, job, today, undefined, appId) : null;
  if (already) await sendLeadCard(sql, appId, today); // same job and description as before: reuse that score
  const f = queued ? await fire(sql, `judge your lead ${lead.company}`) : { fired: false, note: already ? 'already judged' : 'waiting for a description' };
  const state = (await repo.getApplication(sql, appId))?.state ?? 'today';
  return { appId, jobId, jd, jdChars: jd.length, how, contactNote, queued: !!queued, fireNote: f.note, state };
}

export interface LeadPending {
  promptId: number | null; // the "reply with the JD" prompt, when one was sent
  jobId: number;
  appId: number;
  jd: string;
  lastAt: number;
}

export const LEAD_PENDING_KEY = 'lead_pending';
const CONTINUATION_MS = 90_000; // Telegram splits a long paste into several messages that arrive within seconds

/** Is this plain message more description for the last lead (a reply to the prompt, or the rest of a long paste)? */
export function isLeadContinuation(p: LeadPending | null, msg: { reply_to_message?: { message_id?: number } }, text: string, now = Date.now()): boolean {
  if (!p || text.startsWith('/')) return false;
  if (p.promptId && msg.reply_to_message?.message_id === p.promptId) return true;
  return p.lastAt > 0 && now - p.lastAt < CONTINUATION_MS && !msg.reply_to_message;
}

/** Adds description text to a lead and re-queues judging; any older queued judging for that job is superseded. */
export async function appendLeadJd(sql: Sql, p: LeadPending, chunk: string, today: string) {
  const jd = `${p.jd}\n${chunk}`.trim().slice(0, 20000);
  await repo.setJd(sql, p.jobId, jd);
  await sql`UPDATE worker_tasks SET status = 'failed', error = 'superseded by a longer description', done_at = now()
            WHERE kind = 'judge' AND ref LIKE ${`job:${p.jobId}:%`} AND status = 'queued'`;
  await repo.kvSet(sql, LEAD_PENDING_KEY, { ...p, jd, lastAt: Date.now() });
  const job = await repo.jobToJudgeById(sql, p.jobId);
  if (job && jd.length >= JD_MIN) {
    await queueJudgeJob(sql, job, today, undefined, p.appId);
    await fire(sql, 'judge your lead');
  }
  return { chars: jd.length, judging: jd.length >= JD_MIN };
}

/** Tells you what happened to a lead (typed or from screenshots) and, without a usable description, asks for one. */
export async function announceLead(sql: Sql, lead: Lead, r: Awaited<ReturnType<typeof createLead>>, sourceText = '') {
  if (!['today', 'snoozed'].includes(r.state)) {
    return void (await tg.send(`${escapeHtml(lead.company)}, ${escapeHtml(lead.role)} is already in your pipeline (application ${r.appId}, ${r.state}).`));
  }
  const lines = [`Added <b>${escapeHtml(lead.company)}</b>, ${escapeHtml(lead.role)} (application ${r.appId}).${escapeHtml(r.contactNote)}`];
  if (r.jdChars < JD_MIN) {
    const promptId = await tg.askForReply(`No usable description yet (${escapeHtml(r.how)}). Reply to this message with the job description as text; long pastes in several parts are fine.`, 'Job description');
    await repo.kvSet(sql, LEAD_PENDING_KEY, { promptId, jobId: r.jobId, appId: r.appId, jd: r.jd, lastAt: Date.now() } satisfies LeadPending);
    return void (await tg.send(lines.join('\n')));
  }
  lines.push(`Description ${escapeHtml(r.how)}. Scoring it now; the card with Apply, Skip and Snooze follows in a minute or two.`);
  // Telegram splits a paste over 4096 characters; only then do the next plain messages count as more description.
  const maybeSplit = sourceText.length >= 3500;
  await repo.kvSet(sql, LEAD_PENDING_KEY, { promptId: null, jobId: r.jobId, appId: r.appId, jd: r.jd, lastAt: maybeSplit ? Date.now() : 0 } satisfies LeadPending);
  await tg.send(lines.join('\n'));
}

// ---------- screenshots ----------

export const SHOTS_KEY = 'lead_shots';
export const SHOTS_QUIET_MS = 20_000; // screenshots sent together (an album, or one after another) are read as one post
export const MAX_SHOTS = 6;

export interface Shot {
  fileId: string;
  caption: string;
  messageId: number;
}

/** Adds a screenshot to the batch being collected. Atomic, because an album arrives as several webhook calls at once. */
export async function addShot(sql: Sql, shot: Shot, now = Date.now()): Promise<number> {
  const r = await sql`INSERT INTO kv (key, value, updated_at)
                        VALUES (${SHOTS_KEY}, jsonb_build_object('shots', jsonb_build_array(${JSON.stringify(shot)}::jsonb), 'lastAt', ${now}::bigint), now())
                      ON CONFLICT (key) DO UPDATE SET
                        value = jsonb_build_object('shots', COALESCE(kv.value->'shots', '[]'::jsonb) || jsonb_build_array(${JSON.stringify(shot)}::jsonb), 'lastAt', ${now}::bigint),
                        updated_at = now()
                      RETURNING jsonb_array_length(value->'shots') AS n`;
  return Number(r[0].n);
}

/** Takes the batch once no screenshot has arrived for SHOTS_QUIET_MS; null while more may still come. */
export async function takeShots(sql: Sql, now = Date.now()): Promise<Shot[] | null> {
  const r = await sql`DELETE FROM kv WHERE key = ${SHOTS_KEY} AND (value->>'lastAt')::bigint <= ${now - SHOTS_QUIET_MS}::bigint RETURNING value`;
  return r.length ? ((r[0].value?.shots ?? []) as Shot[]) : null;
}

/** Downloads the screenshots and queues them for the worker to read. */
export async function queueScreenshots(sql: Sql, shots: Shot[]) {
  const use = shots.slice(0, MAX_SHOTS);
  const images: { mime: string; b64: string }[] = [];
  for (const s of use) {
    const f = await tg.downloadBytes(s.fileId);
    images.push({ mime: f.mime, b64: Buffer.from(f.bytes).toString('base64') });
  }
  const caption = use.map((s) => s.caption).filter(Boolean).join('\n').slice(0, 1000);
  const t = await queueLeadShots(sql, images, caption, use[0].messageId);
  const f = await fire(sql, `read ${images.length} screenshot${images.length === 1 ? '' : 's'} for a lead`);
  return { taskId: t, count: images.length, dropped: shots.length - use.length, fireNote: f.note };
}
