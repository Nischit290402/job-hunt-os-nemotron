/**
 * What a tap does. Shared by Telegram buttons and the dashboard, so both behave the same.
 * Every outward action here is reached only through a signed callback (Telegram) or a signed-in session (dashboard).
 */
import type { Sql } from './sql';
import * as repo from './repo';
import { sendDraft } from './outreach';
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
        if (!r.ok) return { text: `Not sent: ${escapeHtml(r.reason)}.`, keepButtons: true };
        if (draft?.kind === 'ask' && app.state === 'awaiting_send') {
          await repo.applyEvent(sql, appId, 'outreach.sent', 'you');
          await emit(EV.outreachDecided, { applicationId: appId, decision: 'sent' });
        }
        return {
          text: r.channel === 'email'
            ? `Sent to ${escapeHtml(r.to)}. I will wait 3 days or until they reply, then queue the application.`
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
        const promptId = await tg.askForReply(`Reply to this message with the new email text for ${app.company}. Your text replaces the draft body.`);
        await repo.kvSet(sql, 'edit_pending', { promptId, messageId: draft.id, appId });
        return { text: 'Waiting for your new text.', keepButtons: true };
      }
      case 'submitted': {
        await repo.applyEvent(sql, appId, 'submitted', 'you', { appliedAt: today });
        await emit(EV.submitted, { applicationId: appId });
        return { text: `Marked ${label} as applied on ${today}.` };
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
