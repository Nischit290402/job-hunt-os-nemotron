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
import { callText } from './anthropic';
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
  '/health: sources, runs and spend',
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
      const lines = PIPELINE_COLUMNS.map((c) => {
        const n = rows.filter((r) => c.states.includes(r.state)).length;
        return `${c.title}: ${n}`;
      });
      return void (await tg.send(`<b>Pipeline</b>\n${lines.join('\n')}\n${env.appUrl()}/pipeline`));
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
    case '/retry': {
      if (!/^\d+$/.test(arg)) return void (await tg.send('Usage: /retry &lt;app id&gt;'));
      await emit(EV.apply, { applicationId: Number(arg) });
      return void (await tg.send(`Restarted the workflow for application ${arg}. Steps already done are skipped.`));
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
      const tk = await repo.tokensThisMonth(sql, today);
      const failing = (await repo.listSources(sql)).filter((s) => s.last_status && !String(s.last_status).startsWith('ok'));
      const master = await repo.kvGet<{ syncedAt: string; vaultModified: string }>(sql, 'master_resume');
      return void (await tg.send([
        `Sources ok today: ${h.sourcesOk}/${h.sourcesTotal}. Failed steps today: ${h.failedSteps}. Judged today: ${h.judgedToday}.`,
        `Firecrawl: ${fc.today} today, ${fc.month} this month, ${fc.total} total. Claude tokens this month: ${tk.in.toLocaleString('en-SG')} in.`,
        failing.length ? `Not ok: ${failing.map((s) => `${s.id} (${escapeHtml(s.last_status)})`).join(', ')}` : 'All sources ok.',
        master ? `Master resume: vault edit of ${master.vaultModified.slice(0, 10)}, synced ${master.syncedAt.slice(0, 10)}.` : 'Master resume: never synced. Start the laptop agent once.',
      ].join('\n')));
    }
    default:
      return coach(sql, text, today);
  }
}

/** Read-only coach in the job-fetcher-coach voice. It sees a summary of the database and cannot change anything. */
async function coach(sql: Sql, question: string, today: string) {
  const d = await briefData(sql, today);
  const top = await sql`SELECT j.id, j.company, j.title, j.track, lj.score, lj.verdict, lj.notes, lj.flags, lj.deadline
                        FROM jobs j JOIN latest_judgments lj ON lj.job_id = j.id
                        WHERE j.closed_at IS NULL AND lj.verdict <> 'Skip' ORDER BY lj.score DESC LIMIT 15`;
  const pipeline = await repo.appsInStates(sql, ['tailoring', 'finding_contact', 'awaiting_send', 'ask_sent', 'ready_to_fill', 'prefilled', 'applied', 'interview']);
  const profile = await repo.getProfile(sql);
  const system = [
    'You are a senior hiring manager in AI and quant in Singapore who mentors graduate students. Blunt, specific, short. No cheerleading, no emojis, no em dashes.',
    'Answer from the data below only. If the data does not cover the question, say so. You cannot change anything; suggest the command or button the user should use.',
    'Use plain text that renders in Telegram HTML: no markdown headings or tables.',
    `Candidate profile:\n${clip(profile.body, 3000)}`,
    `Today list:\n${d.today.map((t) => `- [app ${t.applicationId}] ${t.company}, ${t.title}: ${t.score} ${t.verdict}. ${t.notes}`).join('\n') || '- empty'}`,
    `In progress:\n${pipeline.map((p) => `- [app ${p.id}] ${p.company}, ${p.title}: ${p.state}`).join('\n') || '- none'}`,
    `Top open jobs:\n${top.map((t) => `- [job ${t.id}] ${t.company}, ${t.title} (${t.track}): ${t.score} ${t.verdict}. ${t.notes}`).join('\n')}`,
  ].join('\n\n');
  const r = await callText({ model: env.writerModel(), system, user: question, maxTokens: 700, timeoutMs: 40_000 });
  await repo.recordRun(sql, { step: 'coach', seconds: 0, ok: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
  await tg.send(escapeHtml(r.text).slice(0, 4000));
}
