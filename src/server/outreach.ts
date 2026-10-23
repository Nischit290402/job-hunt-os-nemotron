/** Drafting and sending referral asks. Sending runs only from a signed Send tap (actions.ts). */
import type { Sql } from './sql';
import * as repo from './repo';
import { env, features } from './env';
import { callTool } from './anthropic';
import { sendEmail } from './gmail';
import { buildDraftPrompt, checkSendAllowed, DRAFT_TOOL, followUpBody, normalizeDraft } from '../core/outreach';
import { clip } from '../core/html';
import { splitName } from '../core/contacts';

export async function draftFor(sql: Sql, app: repo.AppRow, contactId: number): Promise<number> {
  const contact = await repo.getContact(sql, contactId);
  if (!contact) throw new Error(`contact ${contactId} not found`);
  const profile = await repo.getProfile(sql);
  const p = buildDraftPrompt({
    candidateSummary: profile.outreach_summary || clip(profile.body, 2500),
    contactName: contact.name,
    contactHeadline: contact.headline,
    contactKind: contact.kind,
    relation: contact.relation,
    company: app.company,
    role: app.title,
    applyUrl: app.url,
    jdExcerpt: clip(app.jd_text || '', 3000),
  });
  const started = Date.now();
  const r = await callTool({ model: env.writerModel(), system: p.system, user: p.user, tool: DRAFT_TOOL, maxTokens: 900 });
  const d = normalizeDraft(r.input);
  await repo.recordRun(sql, { step: 'draft', seconds: (Date.now() - started) / 1000, ok: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
  return repo.insertDraft(sql, {
    appId: app.id, contactId, kind: 'ask', subject: d.subject, body: d.emailBody, linkedinNote: d.linkedinNote,
    channel: contact.email && features.gmail() ? 'email' : 'linkedin',
  });
}

export type SendOutcome = { ok: true; channel: 'email' | 'linkedin'; to: string } | { ok: false; reason: string };

/** Sends the pending draft for an application. Email when the contact has an address and Gmail is set up; otherwise records that you sent the LinkedIn note yourself. */
export async function sendDraft(sql: Sql, appId: number, today: string): Promise<SendOutcome> {
  const draft = await repo.latestDraft(sql, appId);
  if (!draft) return { ok: false, reason: 'no draft waiting' };
  if (draft.channel === 'email' && draft.email) {
    const counts = await repo.sendCounts(sql, today);
    const allowed = checkSendAllowed({
      sentToday: counts.today, sentThisWeek: counts.week, email: draft.email, doNotContact: await repo.doNotContactSet(sql),
      paused: await repo.isPaused(sql), isFollowUp: draft.kind === 'followup',
    });
    if (!allowed.ok) return allowed;
    await repo.logEvent(sql, 'message', draft.id, 'send.attempt', 'you', { to: draft.email });
    const g = await sendEmail({ to: draft.email, subject: draft.subject, body: draft.body, threadId: draft.gmail_thread_id ?? undefined });
    await repo.markMessageSent(sql, draft.id, 'email', g);
    return { ok: true, channel: 'email', to: draft.email };
  }
  await repo.markMessageSent(sql, draft.id, 'linkedin');
  return { ok: true, channel: 'linkedin', to: draft.contact_name };
}

/** Follow-up drafts for asks with no reply after 5 days, once. They still need your Send tap. */
export async function draftFollowUp(sql: Sql, sent: { id: number; application_id: number; gmail_thread_id: string }, contact: { contact_id: number; name: string }, role: string) {
  const { first } = splitName(contact.name);
  return repo.insertDraft(sql, {
    appId: sent.application_id, contactId: contact.contact_id, kind: 'followup', subject: `Re: ${role}`, body: followUpBody(first, role),
    linkedinNote: '', channel: 'email', threadId: sent.gmail_thread_id,
  });
}
