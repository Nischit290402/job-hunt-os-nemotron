/**
 * Gmail API. Referral emails are only ever saved to your Gmail drafts (gmail.compose); you review and send them from
 * Gmail yourself. gmail.metadata reads thread headers to notice when you sent a draft and whether anyone replied.
 * The refresh token comes from a one-time consent run (scripts/gmail-auth.ts).
 */
import { env } from './env';
import { buildRawEmail } from '../core/outreach';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.metadata'];

let cachedToken: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.gmailClientId(),
      client_secret: env.gmailClientSecret(),
      refresh_token: env.gmailRefreshToken(),
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new Error(`Gmail token refresh failed: ${data.error ?? res.status}`);
  cachedToken = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

/** Saves the email to your Gmail drafts. Nothing is sent: this app has no code path that calls drafts.send or messages.send. */
export async function createGmailDraft(m: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string }): Promise<{ draftId: string; id: string; threadId: string }> {
  const raw = buildRawEmail({ from: env.gmailFrom(), to: m.to, subject: m.subject, body: m.body, inReplyTo: m.inReplyTo, references: m.inReplyTo });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: m.threadId ? { raw, threadId: m.threadId } : { raw } }),
  });
  const data = (await res.json()) as { id?: string; message?: { id?: string; threadId?: string }; error?: { message?: string } };
  if (!data.id || !data.message?.threadId) throw new Error(`Gmail draft failed: ${data.error?.message ?? res.status}`);
  return { draftId: data.id, id: data.message.id ?? '', threadId: data.message.threadId };
}

/** Reads headers only: whether you sent a message in the thread (and when), and whether someone else replied. */
export async function threadHasReply(threadId: string): Promise<{ replied: boolean; lastMessageId?: string; bounce: boolean; sentAt?: string }> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok) throw new Error(`Gmail thread read failed: ${res.status}`);
  const data = (await res.json()) as { messages?: { labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }[] };
  const me = env.gmailFrom().toLowerCase();
  let replied = false;
  let bounce = false;
  let lastMessageId: string | undefined;
  let sentAt: string | undefined;
  for (const msg of data.messages ?? []) {
    if (!sentAt && msg.labelIds?.includes('SENT') && msg.internalDate) sentAt = new Date(Number(msg.internalDate)).toISOString();
    const h = Object.fromEntries((msg.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    lastMessageId = h['message-id'] ?? lastMessageId;
    const from = String(h.from ?? '').toLowerCase();
    if (/mailer-daemon|postmaster/.test(from)) bounce = true;
    else if (from && !from.includes(me)) replied = true;
  }
  return { replied, lastMessageId, bounce, sentAt };
}
