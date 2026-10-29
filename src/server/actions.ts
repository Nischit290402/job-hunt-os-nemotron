/**
 * What a tap does. Shared by Telegram buttons and the dashboard, so both behave the same.
 * Every outward action here is reached only through a signed callback (Telegram) or a signed-in session (dashboard).
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { sendDraft } from './outreach';
import { createGmailDraft } from './gmail';
import { features } from './env';
import { applicationEmail } from '../core/outreach';
import { resumeFileName, searchName } from '../core/contacts';
import { emit, EV } from '../inngest/client';
import { addDays } from '../core/time';
import { SKIP_REASONS, type Action } from '../core/signing';
import { skipReasonKeyboard, escapeHtml, type Keyboard } from '../core/brief';
import { TransitionError } from '../core/state';
import { ConflictError } from './repo';
import * as tg from './telegram';

export interface ActionResult {
  text: string;
  keyboard?: Keyboard; // replaces the card's buttons; undefined = remove them
  keepButtons?: boolean;
}

export async function handleAction(sql: Sql, action: Action, appId: number, today: string): Promise<ActionResult> {
  const app = await repo.getApplication(sql, appId);
  if (!app) return { text: 'That item no longer exists.' };
  const label = `<b>${escapeHtml(app.company)}</b>, ${escapeHtml(app.title)}`;
  try {
    switch (action) {
      case 'apply': {
        await repo.applyEvent(sql, appId, 'decide.apply', 'you');
        try {
          await emit(EV.apply, { applicationId: appId });
        } catch {
          return { text: `Marked ${label} as Apply, but the workflow did not start. Send /retry ${appId} to start it.` };
        }
        return { text: `Applying to ${label}. Resume first, then a contact search. I will message you at each step.` };
      }
      case 'skip':
        return { text: `Why skip ${label}?`, keyboard: await skipReasonKeyboard(appId, tg.signer) };
      case 'skip:scope':
      case 'skip:location':
      case 'skip:company':
      case 'skip:level':
      case 'skip:other': {
        const reason = SKIP_REASONS[action];
        await repo.applyEvent(sql, appId, 'decide.skip', 'you', { skipReason: reason });
        await repo.addPreference(sql, 'skip_feedback', `${app.company}, ${app.title}: ${reason}`, 'skip');
        return { text: `Skipped ${label} (${reason}). The judge will weigh this on similar roles.` };
      }
      case 'snooze': {
        const until = addDays(today, 3);
        const s = await repo.applyEvent(sql, appId, 'decide.snooze', 'you', { snoozeUntil: until });
        return { text: s === 'skipped' ? `${label} was already snoozed once, so it is now skipped.` : `Snoozed ${label} until ${until}.` };
      }
      case 'send': {
        const draft = await repo.latestDraft(sql, appId);
        const r = await sendDraft(sql, appId, today);
        if (!r.ok) return { text: `Not saved: ${escapeHtml(r.reason)}.`, keepButtons: true };
        if (draft?.kind === 'ask' && app.state === 'awaiting_send') {
          await repo.applyEvent(sql, appId, 'outreach.sent', 'you');
          await emit(EV.outreachDecided, { applicationId: appId, decision: 'sent' });
        }
        return {
          text: r.channel === 'email'
            ? `Saved to your Gmail drafts (to ${escapeHtml(r.to)}). Review and send it from Gmail: https://mail.google.com/mail/u/0/#drafts . I will wait 3 days or until they reply, then queue the application.`
            : `Noted that you sent the LinkedIn note to ${escapeHtml(r.to)}. Waiting 3 days or for a reply.`,
        };
      }
      case 'drop': {
        const draft = await repo.latestDraft(sql, appId);
        if (draft) await repo.markMessage(sql, draft.id, 'dropped');
        if (app.state === 'awaiting_send') {
          await repo.applyEvent(sql, appId, 'outreach.dropped', 'you');
          await emit(EV.outreachDecided, { applicationId: appId, decision: 'dropped' });
        }
        return { text: `Dropped the draft for ${label}. Moving on to the application.` };
      }
      case 'edit': {
        const draft = await repo.latestDraft(sql, appId);
        if (!draft) return { text: 'No draft to edit.' };
        const promptId = await tg.askForReply(`Reply to this message with the new email text for ${escapeHtml(app.company)}. Your text replaces the draft body.`);
        await repo.kvSet(sql, 'edit_pending', { promptId, messageId: draft.id, appId });
        return { text: 'Waiting for your new text.', keepButtons: true };
      }
      case 'submitted': {
        await repo.applyEvent(sql, appId, 'submitted', 'you', { appliedAt: today });
        await emit(EV.submitted, { applicationId: appId });
        return { text: `Marked ${label} as applied on ${today}.` };
      }
      case 'emailapply': {
        if (app.apply_route !== 'email' || !app.apply_email) return { text: `${label} does not take applications by email.` };
        if (!features.gmail()) return { text: `Gmail is not connected. Email ${escapeHtml(app.apply_email)} yourself with the resume PDF from this chat.`, keepButtons: true };
        if ((await repo.doNotContactSet(sql)).has(app.apply_email.toLowerCase())) return { text: `${escapeHtml(app.apply_email)} is on your do-not-contact list.` };
        const resume = await repo.latestResume(sql, appId);
        if (!resume) return { text: `No tailored resume yet for ${label}. Send /tailor ${appId} first.`, keepButtons: true };
        const profile = await repo.getProfile(sql);
        const m = applicationEmail(app.title, searchName(app.company), profile.outreach_summary || '');
        const file = resumeFileName(app.company, app.title, today.slice(0, 4));
        try {
          await createGmailDraft({ to: app.apply_email, subject: m.subject, body: m.body, attachment: { filename: file, mimeType: 'application/pdf', base64: resume.pdf_base64 } });
        } catch (e) {
          return { text: `Not saved: ${escapeHtml(e instanceof Error ? e.message : String(e))}.`, keepButtons: true };
        }
        await repo.logEvent(sql, 'application', appId, 'email_apply.drafted', 'you', { to: app.apply_email });
        return {
          text: `Saved to your Gmail drafts: application to ${escapeHtml(app.apply_email)} with ${escapeHtml(file)} attached. Review and send it from Gmail (https://mail.google.com/mail/u/0/#drafts), then tap I submitted it.`,
          keyboard: [[{ text: 'I submitted it', callback_data: await tg.signer('sb', appId) }]],
        };
      }
      case 'notnow':
        return { text: `Okay. ${label} stays in the queue and comes back in the next brief.` };
      case 'jd':
        return { text: `${label}: ${escapeHtml(app.url)}`, keepButtons: true };
    }
  } catch (e) {
    if (e instanceof TransitionError || e instanceof ConflictError) {
      return { text: `${label} has already moved on (now: ${(await repo.getApplication(sql, appId))?.state}). Nothing changed.` };
    }
    throw e;
  }
}
