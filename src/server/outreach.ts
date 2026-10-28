/** Drafting and sending referral asks. Sending runs only from a signed Send tap (actions.ts). */
import type { Sql } from './sql';
import * as repo from './repo';
import { features } from './env';
import { sendEmail } from './gmail';
import { checkSendAllowed, followUpBody } from '../core/outreach';
import { splitName } from '../core/contacts';

export type SendOutcome = { ok: true; channel: 'email' | 'linkedin'; to: string } | { ok: false; reason: string };

/**
 * Sends the pending draft for an application. Email when the contact has an address and Gmail is set up; otherwise
 * records that you sent the LinkedIn note yourself. The draft row is claimed first, so two taps cannot send twice.
 */
export async function sendDraft(sql: Sql, appId: number, today: string): Promise<SendOutcome> {
  const draft = await repo.latestDraft(sql, appId);
  if (!draft) return { ok: false, reason: 'no draft waiting (already sent or dropped)' };
  const isEmail = draft.channel === 'email' && !!draft.email;
  if (isEmail) {
    const counts = await repo.sendCounts(sql, today);
    const allowed = checkSendAllowed({
      sentToday: counts.today, sentThisWeek: counts.week, email: draft.email, doNotContact: await repo.doNotContactSet(sql),
      paused: await repo.isPaused(sql), isFollowUp: draft.kind === 'followup',
    });
    if (!allowed.ok) return allowed;
  }
  if (!(await repo.claimDraftForSend(sql, draft.id))) return { ok: false, reason: 'already sent' };
  if (!isEmail) {
    await repo.finalizeSent(sql, draft.id, 'linkedin');
    return { ok: true, channel: 'linkedin', to: draft.contact_name };
  }
  await repo.logEvent(sql, 'message', draft.id, 'send.attempt', 'you', { to: draft.email });
  try {
    const g = await sendEmail({ to: draft.email, subject: draft.subject, body: draft.body, threadId: draft.gmail_thread_id ?? undefined, inReplyTo: draft.in_reply_to ?? undefined });
    await repo.finalizeSent(sql, draft.id, 'email', g);
    return { ok: true, channel: 'email', to: draft.email };
  } catch (e) {
    await repo.releaseDraft(sql, draft.id);
    return { ok: false, reason: `Gmail error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Follow-up drafts for asks with no reply after 5 days, once. They still need your Send tap. */
export async function draftFollowUp(
  sql: Sql,
  sent: { id: number; application_id: number; gmail_thread_id: string; subject: string },
  contact: { contact_id: number; name: string },
  role: string,
  inReplyTo: string | undefined
) {
  const { first } = splitName(contact.name);
  // Same subject with "Re:" plus In-Reply-To keeps the follow-up in the original Gmail thread.
  const subject = /^re:/i.test(sent.subject) ? sent.subject : `Re: ${sent.subject}`;
  return repo.insertDraft(sql, {
    appId: sent.application_id, contactId: contact.contact_id, kind: 'followup', subject, body: followUpBody(first, role),
    linkedinNote: '', channel: 'email', threadId: sent.gmail_thread_id, inReplyTo: inReplyTo ?? null,
  });
}
