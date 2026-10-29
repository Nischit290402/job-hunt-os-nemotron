/**
 * Telegram message layouts: the morning brief, job cards and draft cards.
 * Pure: buttons are produced by a sign() callback the caller supplies, so this file has no secrets.
 */
import type { ActionCode } from './signing';

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}
export type Keyboard = Button[][];
export type Signer = (code: ActionCode, id: number) => Promise<string>;

export interface OutMessage {
  text: string; // Telegram HTML parse mode
  keyboard?: Keyboard;
}

export const escapeHtml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface TodayItem {
  applicationId: number;
  jobId: number;
  company: string;
  title: string;
  score: number;
  verdict: string;
  family: string;
  notes: string;
  flags: string[];
  deadline: string;
  contact: string | null;
  daysWaiting: number;
}

export interface ApprovalItem {
  applicationId: number;
  jobId?: number;
  contactName: string;
  contactHeadline: string;
  company: string;
  role: string;
  subject: string;
  body: string;
  email: string | null;
  linkedinUrl: string | null;
  linkedinNote: string;
}

export interface ReadyItem {
  applicationId: number;
  company: string;
  title: string;
  state: 'ready_to_fill' | 'prefilled';
  applyUrl: string;
}

export interface Health {
  sourcesOk: number;
  sourcesTotal: number;
  failedSteps: number;
  judgedToday: number;
  lastJudgeAt: string | null;
  firecrawlToday: number;
}

export interface Week {
  applied: number;
  referralsSent: number;
  target: number;
}

export interface BriefData {
  date: string;
  dashboardUrl: string;
  today: TodayItem[];
  approvals: ApprovalItem[];
  ready: ReadyItem[];
  health: Health;
  week: Week;
  paused: boolean;
}

export function healthLine(h: Health): string {
  const parts = [`${h.sourcesOk}/${h.sourcesTotal} sources ok`, `judged ${h.judgedToday} today`];
  if (h.failedSteps) parts.push(`${h.failedSteps} failed step${h.failedSteps === 1 ? '' : 's'}`);
  if (h.firecrawlToday) parts.push(`Firecrawl ${h.firecrawlToday} credits`);
  return `Health: ${parts.join(', ')}.`;
}

export function headerText(d: BriefData): string {
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  const lines = [
    `<b>Good morning.</b> ${n(d.today.length, 'job', 'jobs')} to decide, ${n(d.approvals.length, 'draft', 'drafts')} to approve, ${n(d.ready.length, 'application', 'applications')} to submit.`,
  ];
  if (d.paused) lines.push('Outward actions are <b>paused</b>. Send /resume to turn them back on.');
  if (!d.today.length && !d.approvals.length && !d.ready.length) lines.push('Nothing needs you today.');
  lines.push('', escapeHtml(healthLine(d.health)));
  lines.push(`This week: ${d.week.applied} applied, ${d.week.referralsSent} referral asks sent, target ${d.week.target}.`);
  return lines.join('\n');
}

export async function todayCard(it: TodayItem, idx: number, sign: Signer, dashboardUrl: string): Promise<OutMessage> {
  const lines = [
    `<b>${idx}. ${escapeHtml(it.company)}</b>, ${escapeHtml(it.title)} <i>(app ${it.applicationId})</i>`,
    `Score ${it.score} (${escapeHtml(it.verdict)}, ${escapeHtml(it.family)})${it.deadline && it.deadline !== 'rolling' ? `. Closes ${it.deadline}` : ''}`,
    escapeHtml(it.notes),
  ];
  if (it.flags.length) lines.push(`Flags: ${escapeHtml(it.flags.join('; '))}`);
  lines.push(`Contact: ${it.contact ? escapeHtml(it.contact) : 'none found yet'}`);
  if (it.daysWaiting >= 2) lines.push('<i>Waiting 2+ days. It will be snoozed tomorrow if you do not decide.</i>');
  return {
    text: lines.join('\n'),
    keyboard: [
      [
        { text: 'Apply', callback_data: await sign('ap', it.applicationId) },
        { text: 'Skip', callback_data: await sign('sk', it.applicationId) },
        { text: 'Snooze 3d', callback_data: await sign('sz', it.applicationId) },
      ],
      [{ text: 'Open job', url: `${dashboardUrl}/jobs/${it.jobId}` }],
    ],
  };
}

export async function skipReasonKeyboard(applicationId: number, sign: Signer): Promise<Keyboard> {
  return [
    [
      { text: 'Wrong scope', callback_data: await sign('s1', applicationId) },
      { text: 'Location/timing', callback_data: await sign('s2', applicationId) },
    ],
    [
      { text: 'Company', callback_data: await sign('s3', applicationId) },
      { text: 'Level/eligibility', callback_data: await sign('s4', applicationId) },
      { text: 'Other', callback_data: await sign('s5', applicationId) },
    ],
  ];
}

export async function approvalCard(a: ApprovalItem, sign: Signer): Promise<OutMessage> {
  const lines = [
    `<b>Referral ask</b> to ${escapeHtml(a.contactName)} (${escapeHtml(a.contactHeadline)}) for ${escapeHtml(a.company)}, ${escapeHtml(a.role)} <i>(app ${a.applicationId})</i>`,
  ];
  if (a.email) {
    lines.push(`Email to ${escapeHtml(a.email)}`, `<b>Subject:</b> ${escapeHtml(a.subject)}`, `<pre>${escapeHtml(a.body)}</pre>`);
  } else {
    lines.push('No verified email. Send the LinkedIn note yourself from the app.');
  }
  if (a.linkedinUrl || !a.email) lines.push(`LinkedIn message (copy, then send it yourself from the LinkedIn app):`, `<code>${escapeHtml(a.linkedinNote)}</code>`);
  const row1: Button[] = [];
  if (a.email) row1.push({ text: 'Save to Gmail drafts', callback_data: await sign('se', a.applicationId) });
  row1.push({ text: 'Edit', callback_data: await sign('ed', a.applicationId) });
  row1.push({ text: a.email ? 'Drop' : 'Done on LinkedIn', callback_data: await sign(a.email ? 'dr' : 'se', a.applicationId) });
  const kb: Keyboard = [row1];
  if (a.linkedinUrl) kb.push([{ text: 'Open profile', url: a.linkedinUrl }]);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function readyCard(r: ReadyItem, sign: Signer): Promise<OutMessage> {
  const text =
    r.state === 'prefilled'
      ? `<b>${escapeHtml(r.company)}</b>, ${escapeHtml(r.title)} <i>(app ${r.applicationId})</i>: form filled on your laptop. Review it and click Submit there.`
      : `<b>${escapeHtml(r.company)}</b>, ${escapeHtml(r.title)} <i>(app ${r.applicationId})</i>: ready to fill. Open your laptop and the agent fills it, or apply by hand.`;
  return {
    text,
    keyboard: [
      [
        { text: 'I submitted it', callback_data: await sign('sb', r.applicationId) },
        { text: 'Not now', callback_data: await sign('nn', r.applicationId) },
      ],
      [{ text: 'Open apply page', url: r.applyUrl }],
    ],
  };
}

export async function renderBrief(d: BriefData, sign: Signer): Promise<OutMessage[]> {
  const out: OutMessage[] = [{ text: headerText(d) }];
  let i = 1;
  for (const t of d.today) out.push(await todayCard(t, i++, sign, d.dashboardUrl));
  for (const a of d.approvals) out.push(await approvalCard(a, sign));
  for (const r of d.ready) out.push(await readyCard(r, sign));
  return out;
}
