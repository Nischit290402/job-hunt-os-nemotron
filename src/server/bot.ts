/**
 * Telegram update handler. Serves only TELEGRAM_CHAT_ID; everything else is ignored without a reply.
 * Buttons carry signed, expiring callback data (core/signing). Free text goes to a read-only coach.
 */
import type { Sql } from './sql';
import * as repo from './repo';
import * as tg from './telegram';
import { env } from './env';
import { handleAction } from './actions';
import { importConnections } from './contacts';
import { fire, queueCoach, queueTailor } from './worker';
import { appendLeadJd, createLead, isLeadContinuation, LEAD_PENDING_KEY, type LeadPending } from './lead';
import { parseLead } from '../core/lead';
import { parseJobTypes } from '../core/filters';
import { sendBrief, briefData } from './steps';
import { emit, EV } from '../inngest/client';
import { verifyCallback } from '../core/signing';
import { approvalCard, escapeHtml, todayCard } from '../core/brief';
import { PIPELINE_COLUMNS, type AppState } from '../core/state';
import { sgtDate } from '../core/time';
import { clip } from '../core/html';

const HELP = [
  '<b>Commands</b>',
  '/today: the jobs waiting for a decision',
  '/brief: send the full morning brief now',
  '/pipeline: counts by stage',
  '/job &lt;company&gt;: open jobs at a company with scores',
  '/prefs: list preferences. /prefs rule &lt;text&gt;, /prefs exclude &lt;term&gt;, /prefs drop &lt;id&gt;',
  '/cap &lt;company&gt; &lt;n&gt;: application cap for an employer (e.g. /cap TikTok 2)',
  '/referral &lt;app id&gt; &lt;link&gt;: use a referral link when applying',
  '/submitted &lt;app id&gt;, /outcome &lt;app id&gt; interview|offer|rejected',
  '/pause and /resume: stop or restart all outward actions',
  '/unlock: re-enable dashboard sign-in after too many wrong codes',
  '/retry &lt;app id&gt;: restart an application workflow that stopped',
  '/jobtypes [intern parttime fulltime]: which job types reach Today (send /jobtypes alone to see the current setting)',
  '/lead Company | Role | Person | Link, then the JD on the next lines: add a job you found yourself (person and link optional)',
  '/tailor &lt;app id&gt; [what to change]: make a new resume version, e.g. /tailor 3 lead with statistics',
  '/health: sources, Claude queue, last worker start, master resume sync',
  'Send Connections.csv as a file to refresh your network.',
  'Any other message is a question for the coach.',
].join('\n');

export async function handleUpdate(sql: Sql, update: any): Promise<void> {
  const chatId = String(env.telegramChatId());
  const today = sgtDate();
  // Telegram re-sends an update when it gets no 200 in time; handle each update once.
  if (Number.isInteger(update?.update_id) && !(await repo.claimTelegramUpdate(sql, update.update_id))) return;

  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.message?.chat?.id) !== chatId || String(cq.from?.id) !== chatId) return;
    const v = await verifyCallback(env.signingSecret(), cq.data);
    if (!v.ok) {
      await tg.answerCallback(cq.id, v.reason === 'expired' ? 'This button expired. Use /today.' : 'Invalid button.');
      return;
    }
    await tg.answerCallback(cq.id);
    const r = await handleAction(sql, v.action, v.id, today);
    if (!r.keepButtons) await tg.editKeyboard(cq.message.message_id, r.keyboard ?? null);
    if (r.keyboard) await tg.send({ text: r.text, keyboard: r.keyboard });
    else await tg.send(r.text);
    return;
  }

  const msg = update.message;
  // Same rule as buttons: your private chat, sent by you. Commands from that chat count as your taps.
  if (!msg || String(msg.chat?.id) !== chatId || String(msg.from?.id) !== chatId) return;

  // Connections.csv upload
  if (msg.document) {
    const name = String(msg.document.file_name ?? '');
    if (!/\.csv$/i.test(name)) return void (await tg.send('Send LinkedIn\'s Connections.csv (Settings, Data privacy, Get a copy of your data, Connections).'));
    const text = await tg.downloadFile(msg.document.file_id);
    const r = await importConnections(sql, text, today);
    await tg.send(`Imported ${r.imported} connections across ${r.companies} companies.`);
    return;
  }

  const text = String(msg.text ?? '').trim();
  if (!text) return;

  // Reply to an "edit draft" prompt
  const pending = await repo.kvGet<{ promptId: number; messageId: number; appId: number }>(sql, 'edit_pending');
  if (pending && msg.reply_to_message?.message_id === pending.promptId) {
    await repo.updateDraftBody(sql, pending.messageId, text);
    await repo.kvSet(sql, 'edit_pending', null);
    const d = await repo.latestDraft(sql, pending.appId);
    const app = await repo.getApplication(sql, pending.appId);
    if (d && app) {
      await tg.send(await approvalCard({
        applicationId: app.id, contactName: d.contact_name, contactHeadline: d.contact_headline, company: app.company, role: app.title,
        subject: d.subject, body: d.body, email: d.channel === 'email' ? d.email : null, linkedinUrl: d.linkedin_url, linkedinNote: d.linkedin_note,
      }, tg.signer));
    }
    return;
  }

  // More description for the lead you just added (a reply to the prompt, or the rest of a long paste)
  const lp = await repo.kvGet<LeadPending>(sql, LEAD_PENDING_KEY);
  if (isLeadContinuation(lp, msg, text)) {
    const r = await appendLeadJd(sql, lp!, text, today);
    return void (await tg.send(r.judging ? `Got the description (${r.chars} characters). Scoring it now; the card follows.` : `Got ${r.chars} characters so far. Send more, or the card comes once there is enough to judge.`));
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase().replace(/@.*$/, '')) {
    case '/start':
    case '/help':
      return void (await tg.send(HELP));
    case '/brief':
      await sendBrief(sql, today);
      return;
    case '/today': {
      const d = await briefData(sql, today);
      if (!d.today.length) return void (await tg.send('Nothing waiting for a decision.'));
      let i = 1;
      for (const t of d.today) await tg.send(await todayCard(t, i++, tg.signer, d.dashboardUrl));
      return;
    }
    case '/pipeline': {
      const rows = await repo.appsInStates(sql, PIPELINE_COLUMNS.flatMap((c) => c.states) as AppState[]);
      // Each stage lists its applications with the id the other commands take (/tailor 4, /submitted 4, ...).
      const lines = PIPELINE_COLUMNS.map((c) => {
        const inStage = rows.filter((r) => c.states.includes(r.state));
        if (!inStage.length) return `<b>${c.title}</b>: none`;
        return [`<b>${c.title}</b> (${inStage.length})`, ...inStage.slice(0, 15).map((r) => `  ${r.id}: ${escapeHtml(r.company)}, ${escapeHtml(r.title)}`)].join('\n');
      });
      return void (await tg.send(`<b>Pipeline</b> (number = app id)\n${lines.join('\n')}\n${env.appUrl()}/pipeline`));
    }
    case '/job': {
      if (!arg) return void (await tg.send('Usage: /job &lt;company&gt;'));
      const rows = await sql`SELECT j.id, j.title, lj.score, lj.verdict FROM jobs j LEFT JOIN latest_judgments lj ON lj.job_id = j.id
                             WHERE j.closed_at IS NULL AND j.company ILIKE ${'%' + arg + '%'} ORDER BY lj.score DESC NULLS LAST LIMIT 10`;
      if (!rows.length) return void (await tg.send(`No open jobs at ${escapeHtml(arg)}.`));
      return void (await tg.send(rows.map((r) => `${r.score ?? '-'} ${escapeHtml(r.verdict ?? 'not judged')}: ${escapeHtml(r.title)} ${env.appUrl()}/jobs/${r.id}`).join('\n')));
    }
    case '/prefs': {
      const [sub, ...words] = rest;
      const body = words.join(' ').trim();
      if (sub === 'rule' && body) await repo.addPreference(sql, 'rule', body);
      else if (sub === 'exclude' && body) await repo.addPreference(sql, 'exclude_term', body.toLowerCase());
      else if (sub === 'drop' && /^\d+$/.test(body)) await repo.deactivatePreference(sql, Number(body));
      if (sub === 'rule' || sub === 'exclude' || sub === 'drop') {
        await emit(EV.rejudge, {});
        await tg.send('Saved. Re-scoring open jobs with the new preferences.');
      }
      const prefs = (await repo.listPreferences(sql)).filter((p) => p.kind !== 'skip_feedback');
      return void (await tg.send(prefs.length ? prefs.map((p) => `${p.id}. [${p.kind}] ${escapeHtml(p.text)}`).join('\n') : 'No preferences yet. Example: /prefs rule Core ML or LLM engineering only, no AI agent roles'));
    }
    case '/cap': {
      const m = arg.match(/^(.+?)\s+(\d+|none)$/i);
      if (!m) return void (await tg.send('Usage: /cap TikTok 2 (or /cap TikTok none)'));
      await repo.setEmployerCap(sql, m[1], /none/i.test(m[2]) ? null : Number(m[2]));
      return void (await tg.send(`Cap for ${escapeHtml(m[1])} set to ${m[2]}.`));
    }
    case '/referral': {
      const m = arg.match(/^(\d+)\s+(https?:\/\/\S+)$/);
      if (!m) return void (await tg.send('Usage: /referral &lt;app id&gt; &lt;link&gt;'));
      await repo.setReferralUrl(sql, Number(m[1]), m[2]);
      return void (await tg.send('Referral link saved. Apply-assist will use it.'));
    }
    case '/submitted': {
      if (!/^\d+$/.test(arg)) return void (await tg.send('Usage: /submitted &lt;app id&gt;'));
      return void (await tg.send((await handleAction(sql, 'submitted', Number(arg), today)).text));
    }
    case '/outcome': {
      const m = arg.match(/^(\d+)\s+(interview|offer|rejected)$/i);
      if (!m) return void (await tg.send('Usage: /outcome &lt;app id&gt; interview|offer|rejected'));
      const ev = `outcome.${m[2].toLowerCase()}` as 'outcome.interview' | 'outcome.offer' | 'outcome.rejected';
      const s = await repo.applyEvent(sql, Number(m[1]), ev, 'you').catch((e: Error) => e.message);
      return void (await tg.send(`Application ${m[1]}: ${escapeHtml(String(s))}`));
    }
    case '/lead': {
      const p = parseLead(text);
      if (!p.ok) return void (await tg.send(escapeHtml(p.error)));
      const r = await createLead(sql, p.lead, today);
      if (!['today', 'snoozed'].includes(r.state)) {
        return void (await tg.send(`${escapeHtml(p.lead.company)}, ${escapeHtml(p.lead.role)} is already in your pipeline (application ${r.appId}, ${r.state}).`));
      }
      const enough = r.jdChars >= 300;
      const lines = [`Added <b>${escapeHtml(p.lead.company)}</b>, ${escapeHtml(p.lead.role)} (application ${r.appId}).${escapeHtml(r.contactNote)}`];
      if (enough) lines.push(`Description ${escapeHtml(r.how)}. Scoring it now; the card with Apply, Skip and Snooze follows in a minute or two.`);
      if (!enough) {
        const promptId = await tg.askForReply(`No usable description yet (${escapeHtml(r.how)}). Reply to this message with the job description; long pastes in several parts are fine.`, 'Job description');
        await repo.kvSet(sql, LEAD_PENDING_KEY, { promptId, jobId: r.jobId, appId: r.appId, jd: r.jd, lastAt: Date.now() } satisfies LeadPending);
        return void (await tg.send(lines.join('\n')));
      }
      // Telegram splits a paste over 4096 characters; only then do the next plain messages count as more description.
      const maybeSplit = text.length >= 3500;
      await repo.kvSet(sql, LEAD_PENDING_KEY, { promptId: null, jobId: r.jobId, appId: r.appId, jd: r.jd, lastAt: maybeSplit ? Date.now() : 0 } satisfies LeadPending);
      return void (await tg.send(lines.join('\n')));
    }
    case '/jobtypes': {
      const current = await repo.jobTypes(sql);
      const label = (t: string[]) => t.map((x) => ({ intern: 'internships', parttime: 'part-time', fulltime: 'full-time' })[x] ?? x).join(', ');
      if (!arg) return void (await tg.send(`Today shows: <b>${label(current)}</b>.\nChange with /jobtypes intern parttime fulltime (any of the three).`));
      const next = parseJobTypes(arg);
      if (!next) return void (await tg.send('Use any of: intern, parttime, fulltime. Example: /jobtypes intern parttime'));
      await repo.kvSet(sql, 'job_types', next);
      const ftChanged = current.includes('fulltime') !== next.includes('fulltime');
      if (ftChanged) await emit(EV.rejudge, {}); // full-time verdicts are capped only while you are not looking for full-time
      return void (await tg.send(`Today now shows: <b>${label(next)}</b>.${ftChanged ? ' Re-scoring open jobs so full-time verdicts match; Today refreshes when that finishes.' : ' Takes effect from the next Today refill.'}`));
    }
    case '/tailor': {
      const m = arg.match(/^(\d+)\s*(.*)$/s);
      if (!m) return void (await tg.send('Usage: /tailor &lt;app id&gt; [what to change]'));
      const app = await repo.getApplication(sql, Number(m[1]));
      if (!app) return void (await tg.send(`No application ${m[1]}.`));
      const queued = await queueTailor(sql, app, true, m[2].trim());
      if (!queued) return void (await tg.send(`A resume for ${escapeHtml(app.company)} is already being made.`));
      const f = await fire(sql, `re-tailor resume for ${app.company}`);
      return void (await tg.send(`Making a new resume version for <b>${escapeHtml(app.company)}</b>. It arrives here in a few minutes.${f.fired || f.note.startsWith('a run') ? '' : ` (${escapeHtml(f.note)})`}`));
    }
    case '/retry': {
      if (!/^\d+$/.test(arg)) return void (await tg.send('Usage: /retry &lt;app id&gt;'));
      const attempts = (await repo.kvGet<Record<string, unknown>>(sql, 'agent_attempts')) ?? {};
      delete attempts[arg];
      await repo.kvSet(sql, 'agent_attempts', attempts); // lets the laptop agent fill the form again
      await emit(EV.apply, { applicationId: Number(arg) });
      return void (await tg.send(`Restarted the workflow for application ${arg}. Steps already done are skipped, and the laptop agent will fill the form again.`));
    }
    case '/unlock':
      await repo.invalidateLoginCodes(sql);
      await repo.kvSet(sql, 'login_failures', 0);
      await repo.kvSet(sql, `login_codes_${today}`, 0);
      return void (await tg.send('Dashboard sign-in unlocked. Request a new code on the login page.'));
    case '/pause':
      await repo.kvSet(sql, 'paused', true);
      return void (await tg.send('Paused. No emails will be sent until /resume. Collecting and judging continue.'));
    case '/resume':
      await repo.kvSet(sql, 'paused', false);
      return void (await tg.send('Resumed.'));
    case '/health': {
      const h = await repo.healthSummary(sql, today);
      const fc = await repo.firecrawlCredits(sql, today);
      const q = await repo.queueSummary(sql);
      const lastFire = await repo.kvGet<{ at: string; ok: boolean; note: string }>(sql, 'worker_last_fire_result');
      const failing = (await repo.listSources(sql)).filter((s) => s.last_status && !String(s.last_status).startsWith('ok'));
      const master = await repo.kvGet<{ syncedAt: string; vaultModified: string }>(sql, 'master_resume');
      return void (await tg.send([
        `Sources ok today: ${h.sourcesOk}/${h.sourcesTotal}. Failed steps today: ${h.failedSteps}. Judged today: ${h.judgedToday}.`,
        `Firecrawl: ${fc.today} today, ${fc.month} this month, ${fc.total} total. Claude queue: ${Object.entries(q.open).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty'}${q.stale ? ` (${q.stale} waiting 10+ min)` : ''}.`,
        lastFire ? `Last worker start: ${lastFire.at.slice(0, 16).replace('T', ' ')} UTC, ${escapeHtml(lastFire.note)}.` : 'Worker never started yet.',
        failing.length ? `Not ok: ${failing.map((s) => `${s.id} (${escapeHtml(s.last_status)})`).join(', ')}` : 'All sources ok.',
        master ? `Master resume: vault edit of ${master.vaultModified.slice(0, 10)}, synced ${master.syncedAt.slice(0, 10)}.` : 'Master resume: never synced. Start the laptop agent once.',
      ].join('\n')));
    }
    default:
      return coach(sql, text, today);
  }
}

/** Free text goes to the coach. The worker answers in a minute or two; the coach reads the database and changes nothing. */
async function coach(sql: Sql, question: string, today: string) {
  await queueCoach(sql, question, today);
  const f = await fire(sql, 'coach question');
  await tg.send(f.fired || f.note.startsWith('a run') ? 'Asked Claude. The answer arrives here in a minute or two.' : `Queued for Claude, but ${escapeHtml(f.note)}.`);
}
