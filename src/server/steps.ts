/**
 * Workflow steps. Each one is idempotent: it reads the current state first and does nothing if the step already
 * happened or you moved the application on by hand (for example, tapped "I submitted it" early).
 */
import type { Sql } from './sql';
import * as repo from './repo';
import * as tg from './telegram';
import { env, features } from './env';
import { fire, queueDraft, queueTailor } from './worker';
import { findContact } from './contacts';
import { draftFollowUp } from './outreach';
import { threadHasReply } from './gmail';
import { pickToday } from '../core/ranker';
import { addDays, daysBetween } from '../core/time';
import { approvalCard, escapeHtml, readyCard, renderBrief, type ApprovalItem, type BriefData, type ReadyItem, type TodayItem } from '../core/brief';
import { ConflictError } from './repo';
import type { AppEvent, AppState } from '../core/state';

const TODAY_MAX = 3;

export async function tryEvent(sql: Sql, appId: number, event: AppEvent, expect: AppState[], extra: Parameters<typeof repo.applyEvent>[4] = {}) {
  const app = await repo.getApplication(sql, appId);
  if (!app || !expect.includes(app.state)) return app?.state ?? null;
  try {
    return await repo.applyEvent(sql, appId, event, 'system', extra);
  } catch (e) {
    if (e instanceof ConflictError) return (await repo.getApplication(sql, appId))?.state ?? null;
    throw e;
  }
}

// ---------- daily ----------

/** Auto-snoozes Today items left undecided for 3 days, returns due snoozes, then tops Today up to 3. */
export async function buildToday(sql: Sql, today: string) {
  for (const id of await repo.staleTodayIds(sql, today)) {
    await tryEvent(sql, id, 'decide.snooze', ['today'], { snoozeUntil: addDays(today, 3), note: 'auto-snoozed after 3 days' });
  }
  const current = await repo.appsInStates(sql, ['today']);
  const due = await repo.dueSnoozedIds(sql, today);
  const slots = Math.max(0, TODAY_MAX - current.length);
  const picks = pickToday(await repo.rankCandidates(sql), await repo.employerInfo(sql), { today, max: TODAY_MAX })
    .filter((p) => !current.some((c) => c.job_id === p.jobId))
    .filter((p) => !current.some((c) => c.company === p.company));
  const added: number[] = [];
  for (const p of picks.slice(0, slots)) added.push(await repo.putInToday(sql, p.jobId, today));
  return { kept: current.length, added: added.length, dueSnoozes: due.length };
}

export async function briefData(sql: Sql, today: string): Promise<BriefData> {
  const todayRows = await repo.appsInStates(sql, ['today']);
  const items: TodayItem[] = [];
  for (const r of todayRows) {
    const app = await repo.getApplication(sql, r.id);
    const names = app ? await repo.connectionNamesByCompany(sql, app.company_key, 1) : [];
    items.push({
      applicationId: r.id, jobId: r.job_id, company: r.company, title: r.title, score: Number(r.score ?? 0), verdict: r.verdict ?? '',
      family: r.family, notes: r.notes ?? '', flags: r.flags ?? [], deadline: r.deadline ?? '', contact: names[0] ?? null,
      daysWaiting: daysBetween(r.picked_on, today),
    });
  }
  const approvals: ApprovalItem[] = [];
  for (const r of await repo.appsInStates(sql, ['awaiting_send', 'ready_to_fill', 'prefilled', 'ask_sent', 'applied'])) {
    const d = await repo.latestDraft(sql, r.id);
    if (d) approvals.push(toApproval(r, d));
  }
  const ready: ReadyItem[] = [];
  for (const r of await repo.appsInStates(sql, ['ready_to_fill', 'prefilled'])) {
    const app = await repo.getApplication(sql, r.id);
    ready.push({ applicationId: r.id, company: r.company, title: r.title, state: r.state as ReadyItem['state'], applyUrl: app?.referral_url || r.url });
  }
  return {
    date: today, dashboardUrl: env.appUrl(), today: items, approvals, ready,
    health: await repo.healthSummary(sql, today), week: await repo.weekStats(sql, today), paused: await repo.isPaused(sql),
  };
}

export function toApproval(r: { id: number; company: string; title: string; job_id?: number }, d: Record<string, any>): ApprovalItem {
  return {
    applicationId: r.id, jobId: r.job_id, contactName: d.contact_name, contactHeadline: d.contact_headline, company: r.company, role: r.title,
    subject: d.subject, body: d.body, email: d.channel === 'email' ? d.email : null, linkedinUrl: d.linkedin_url, linkedinNote: d.linkedin_note,
  };
}

export async function sendBrief(sql: Sql, today: string) {
  const d = await briefData(sql, today);
  await tg.sendAll(await renderBrief(d, tg.signer));
  await repo.kvSet(sql, 'last_brief', { date: today, today: d.today.length, approvals: d.approvals.length, ready: d.ready.length });
  return { today: d.today.length, approvals: d.approvals.length, ready: d.ready.length };
}

// ---------- per application ----------

/** Queues tailoring for the worker. The flow then waits for worker/resume.done (or gives up after 3 hours). */
export async function tailor(sql: Sql, appId: number) {
  const app = await repo.getApplication(sql, appId);
  if (!app || app.state !== 'tailoring') return { skipped: true };
  if (await repo.latestResume(sql, appId)) {
    // A retry after the resume was already saved and sent: just move on.
    await tryEvent(sql, appId, 'resume.ready', ['tailoring']);
    return { ok: true, reused: true };
  }
  await queueTailor(sql, app);
  const f = await fire(sql, `tailor resume for ${app.company}`);
  await tg.send(`Tailoring your resume for <b>${escapeHtml(app.company)}</b>. It arrives here in a few minutes.${f.fired ? '' : ` (${escapeHtml(f.note)})`}`);
  return { ok: true, queued: true };
}

/** Tailoring did not finish within the wait: continue with the base resume. */
export async function tailorTimedOut(sql: Sql, appId: number) {
  const app = await repo.getApplication(sql, appId);
  if (!app || app.state !== 'tailoring') return { skipped: true };
  await tg.send(`No tailored resume for <b>${escapeHtml(app.company)}</b> after 3 hours. Continuing with your base resume; it can still arrive later.`);
  return tryEvent(sql, appId, 'resume.unavailable', ['tailoring'], { note: 'worker timeout' });
}

export async function findContactStep(sql: Sql, appId: number, today: string) {
  const app = await repo.getApplication(sql, appId);
  if (!app || app.state !== 'finding_contact') return { contact: false, skipped: true };
  const r = await findContact(sql, app, today);
  if (!r.chosen) {
    await tg.send({
      text: `No contact found at <b>${escapeHtml(app.company)}</b> (${escapeHtml(r.note)}). If you want a referral, pick someone here and send them a note yourself. The application continues without one.`,
      keyboard: [[{ text: 'Search LinkedIn', url: r.searchUrl }]],
    });
    await tryEvent(sql, appId, 'contact.none', ['finding_contact'], { note: r.note });
    return { contact: false };
  }
  await tryEvent(sql, appId, 'contact.found', ['finding_contact'], { contactId: r.chosen.contactId });
  return { contact: true, contactId: r.chosen.contactId };
}

export async function draftStep(sql: Sql, appId: number) {
  const app = await repo.getApplication(sql, appId);
  if (!app || app.state !== 'awaiting_send' || !app.contact_id) return { skipped: true };
  const existing = await repo.latestDraft(sql, appId);
  if (existing) {
    await tg.send(await approvalCard(toApproval({ id: appId, company: app.company, title: app.title, job_id: app.job_id }, existing), tg.signer));
    return { ok: true };
  }
  try {
    await queueDraft(sql, app, app.contact_id); // the approval card is sent when the worker posts the draft
    await fire(sql, `draft referral ask for ${app.company}`);
  } catch (e) {
    // Without a draft the application must not sit in awaiting_send forever: offer Drop to continue.
    await tg.send({
      text: `Could not draft the referral ask for <b>${escapeHtml(app.company)}</b>: ${escapeHtml(e instanceof Error ? e.message : String(e)).slice(0, 200)}. Tap Drop to continue without a referral.`,
      keyboard: [[{ text: 'Drop and continue', callback_data: await tg.signer('dr', appId) }]],
    });
    return { ok: false };
  }
  return { ok: true, queued: true };
}

/** No decision on a draft within 5 days: drop it and move on to applying. */
export async function dropStaleDraft(sql: Sql, appId: number) {
  const d = await repo.latestDraft(sql, appId);
  if (d && d.kind === 'ask') await repo.markMessage(sql, d.id, 'dropped');
  return tryEvent(sql, appId, 'outreach.dropped', ['awaiting_send'], { note: 'no decision in 5 days' });
}

export async function stateOf(sql: Sql, appId: number): Promise<AppState | null> {
  return (await repo.getApplication(sql, appId))?.state ?? null;
}

export async function afterWait(sql: Sql, appId: number, replied: boolean) {
  return tryEvent(sql, appId, replied ? 'reply.received' : 'wait.elapsed', ['ask_sent']);
}

export async function queueFill(sql: Sql, appId: number) {
  const app = await repo.getApplication(sql, appId);
  if (!app || app.state !== 'ready_to_fill') return { skipped: true };
  await tg.send(await readyCard({ applicationId: appId, company: app.company, title: app.title, state: 'ready_to_fill', applyUrl: app.referral_url || app.url }, tg.signer));
  return { ok: true };
}

export async function remindSubmit(sql: Sql, appId: number) {
  const app = await repo.getApplication(sql, appId);
  if (!app || !['ready_to_fill', 'prefilled'].includes(app.state)) return { skipped: true };
  await tg.send(await readyCard({ applicationId: appId, company: app.company, title: app.title, state: app.state as ReadyItem['state'], applyUrl: app.referral_url || app.url }, tg.signer));
  return { reminded: true };
}

// ---------- replies and follow-ups ----------

/** Returns application ids whose referral thread got a reply, so the workflow can stop waiting early. */
export async function checkReplies(sql: Sql, today: string): Promise<{ replied: number[]; followUps: number; bounced: number }> {
  if (!features.gmail()) return { replied: [], followUps: 0, bounced: 0 };
  const replied: number[] = [];
  let followUps = 0;
  let bounced = 0;
  for (const m of await repo.sentEmailsAwaitingReply(sql)) {
    const t = await threadHasReply(m.gmail_thread_id);
    if (t.bounce) {
      await repo.markMessage(sql, m.id, 'dropped');
      await tg.send(`Email to ${escapeHtml(m.contact_name)} bounced. The address is marked unusable.`);
      if (m.email) await repo.setDoNotContact(sql, m.email);
      bounced++;
    } else if (t.replied) {
      await repo.markMessage(sql, m.id, 'replied');
      await tg.send(`<b>${escapeHtml(m.contact_name)}</b> replied about ${escapeHtml(m.title)}. Check Gmail; if they sent a referral link, reply here with /referral ${m.application_id} &lt;link&gt;.`);
      replied.push(Number(m.application_id));
    } else if (Number(m.followups) === 0 && daysBetween(m.sent_at.slice(0, 10), today) >= 5) {
      await draftFollowUp(sql, m, { contact_id: m.contact_id, name: m.contact_name }, m.title, t.lastMessageId);
      const d = await repo.latestDraft(sql, Number(m.application_id));
      const app = await repo.getApplication(sql, Number(m.application_id));
      if (d && app) await tg.send(await approvalCard(toApproval({ id: app.id, company: app.company, title: app.title, job_id: app.job_id }, d), tg.signer));
      followUps++;
    }
  }
  return { replied, followUps, bounced };
}

// ---------- weekly ----------

export async function weeklyReview(sql: Sql, today: string) {
  const f = await repo.weeklyFunnel(sql, today);
  const skips = (await repo.preferenceBundle(sql)).skips.slice(-5);
  const sample = await repo.rejectSample(sql, today, 20);
  const pruned = await repo.pruneOldContacts(sql, today);
  const work = await repo.workerWeek(sql, today);
  const connectionsOn = await repo.kvGet<string>(sql, 'connections_imported_on');
  const lines = [
    '<b>Weekly review</b>',
    `Listed ${f.listed}, judged ${f.judged}, shown in Today ${f.shown}, Apply taps ${f.apply_taps}, skips ${f.skips}.`,
    `Applied ${f.applied}, referral asks ${f.asks}, replies ${f.replies}, interviews in progress ${f.interviews}.`,
    `Claude worker this week: ${work.done} tasks done, ${work.failed} failed.`,
  ];
  if (skips.length) lines.push('', 'Recent skip reasons:', ...skips.map((s) => `- ${escapeHtml(s)}`));
  if (sample.length) lines.push('', 'Rejected by filters (check for good roles that got dropped):', ...sample.slice(0, 20).map((s) => `- ${escapeHtml(s.title)} (${s.reason})`));
  if (!connectionsOn || daysBetween(connectionsOn, today) >= 30) lines.push('', 'Your connections list is over 30 days old. Export Connections.csv from LinkedIn and send the file here.');
  if (pruned) lines.push(`Removed ${pruned} contact(s) with no interaction in 12 months.`);
  await tg.send(lines.join('\n'));
  return f;
}

export async function eveningNudge(sql: Sql, today: string) {
  const waiting = (await repo.appsInStates(sql, ['today'])).filter((r) => daysBetween(r.picked_on, today) >= 2);
  if (!waiting.length) return { sent: false };
  await tg.send(`${waiting.length} job${waiting.length === 1 ? '' : 's'} in Today waiting 2+ days: ${waiting.map((w) => escapeHtml(w.company)).join(', ')}. Decide tonight or they get snoozed tomorrow. /today`);
  return { sent: true };
}
