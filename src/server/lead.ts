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
import { fire, queueJudgeJob, sendLeadCard } from './worker';
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

export async function createLead(sql: Sql, lead: Lead, today: string, now = Date.now()) {
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
  let how = jd.length >= JD_MIN ? 'as you pasted it' : '';
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
