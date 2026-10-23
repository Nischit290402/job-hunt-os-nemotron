import { env } from '@/src/server/env';
import { getSql } from '@/src/server/sql';
import { handleUpdate } from '@/src/server/bot';
import * as tg from '@/src/server/telegram';
import { safeEqual } from '@/src/core/signing';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const got = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!safeEqual(got, env.telegramWebhookSecret())) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  if (!update) return new Response('bad request', { status: 400 });
  try {
    await handleUpdate(await getSql(), update);
  } catch (e) {
    console.error('telegram update failed', e);
    // Answer 200 so Telegram does not retry the same update in a loop; tell the user what broke.
    await tg.send(`Something failed: ${String(e instanceof Error ? e.message : e).slice(0, 300).replace(/[<>&]/g, '')}`).catch(() => undefined);
  }
  return new Response('ok');
}
