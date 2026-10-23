/**
 * Gmail API with the narrowest scopes: gmail.send to send, gmail.metadata to see whether a thread got a reply.
 * The refresh token comes from a one-time consent run (scripts/gmail-auth.ts).
 */
import { env } from './env';
import { buildRawEmail } from '../core/outreach';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.metadata'];

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

export async function sendEmail(m: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string }): Promise<{ id: string; threadId: string }> {
  const raw = buildRawEmail({ from: env.gmailFrom(), to: m.to, subject: m.subject, body: m.body, inReplyTo: m.inReplyTo, references: m.inReplyTo });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(m.threadId ? { raw, threadId: m.threadId } : { raw }),
  });
  const data = (await res.json()) as { id?: string; threadId?: string; error?: { message?: string } };
  if (!data.id || !data.threadId) throw new Error(`Gmail send failed: ${data.error?.message ?? res.status}`);
  return { id: data.id, threadId: data.threadId };
}

/** True when someone other than you has written in the thread. Reads headers only. */
export async function threadHasReply(threadId: string): Promise<{ replied: boolean; lastMessageId?: string; bounce: boolean }> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok) throw new Error(`Gmail thread read failed: ${res.status}`);
  const data = (await res.json()) as { messages?: { payload?: { headers?: { name: string; value: string }[] } }[] };
  const me = env.gmailFrom().toLowerCase();
  let replied = false;
  let bounce = false;
  let lastMessageId: string | undefined;
  for (const msg of data.messages ?? []) {
    const h = Object.fromEntries((msg.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    lastMessageId = h['message-id'] ?? lastMessageId;
    const from = String(h.from ?? '').toLowerCase();
    if (/mailer-daemon|postmaster/.test(from)) bounce = true;
    else if (from && !from.includes(me)) replied = true;
  }
  return { replied, lastMessageId, bounce };
}
