/** Telegram Bot API over fetch. Only ever talks to TELEGRAM_CHAT_ID. */
import { env } from './env';
import { signCallback, type ActionCode } from '../core/signing';
import type { Keyboard, OutMessage, Signer } from '../core/brief';

const api = (method: string) => `https://api.telegram.org/bot${env.telegramToken()}/${method}`;
const CALLBACK_TTL = 7 * 86400;

async function call(method: string, body: object) {
  const res = await fetch(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: any };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

export const signer: Signer = (code: ActionCode, id: number) => signCallback(env.signingSecret(), code, id, CALLBACK_TTL);

export async function send(msg: OutMessage | string): Promise<number> {
  const m = typeof msg === 'string' ? { text: msg } : msg;
  const r = await call('sendMessage', {
    chat_id: env.telegramChatId(),
    text: m.text.slice(0, 4096),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(m.keyboard ? { reply_markup: { inline_keyboard: m.keyboard } } : {}),
  });
  return r.message_id as number;
}

export async function sendAll(msgs: OutMessage[]) {
  for (const m of msgs) await send(m);
}

export async function editKeyboard(messageId: number, keyboard: Keyboard | null) {
  await call('editMessageReplyMarkup', { chat_id: env.telegramChatId(), message_id: messageId, reply_markup: { inline_keyboard: keyboard ?? [] } }).catch(() => undefined);
}

export async function answerCallback(id: string, text?: string) {
  await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) }).catch(() => undefined);
}

/** Asks for a reply, used by Edit draft: the next message that replies to this one becomes the new body. */
export async function askForReply(text: string): Promise<number> {
  const r = await call('sendMessage', { chat_id: env.telegramChatId(), text, reply_markup: { force_reply: true, input_field_placeholder: 'New email text' } });
  return r.message_id as number;
}

export async function sendDocument(filename: string, bytes: Uint8Array, caption: string) {
  const form = new FormData();
  form.set('chat_id', env.telegramChatId());
  form.set('caption', caption.slice(0, 1024));
  form.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), filename);
  const res = await fetch(api('sendDocument'), { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendDocument failed: ${data.description ?? res.status}`);
}

/** Downloads a file the user sent (Connections.csv). */
export async function downloadFile(fileId: string): Promise<string> {
  const f = await call('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.telegramToken()}/${f.file_path}`);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  return res.text();
}

/** One-time setup: point Telegram at this deployment with the secret header. Run via `npm run telegram:webhook`. */
export async function setWebhook(appUrl: string) {
  return call('setWebhook', {
    url: `${appUrl}/api/telegram`,
    secret_token: env.telegramWebhookSecret(),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 1, // updates arrive one at a time and in order, which the update_id dedupe relies on
  });
}
