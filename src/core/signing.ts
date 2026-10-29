/**
 * HMAC signing with Web Crypto, so the same code runs in Node route handlers and in Edge middleware.
 * Used for Telegram button payloads (64-byte limit) and the dashboard session cookie.
 */

const te = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<string> {
  if (!secret || secret.length < 16) throw new Error('signing secret missing or shorter than 16 characters');
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- Telegram callback data ----------

export const ACTIONS = {
  ap: 'apply',
  sk: 'skip', // opens the reason picker
  s1: 'skip:scope',
  s2: 'skip:location',
  s3: 'skip:company',
  s4: 'skip:level',
  s5: 'skip:other',
  sz: 'snooze',
  se: 'send',
  dr: 'drop',
  ed: 'edit',
  sb: 'submitted',
  nn: 'notnow',
  jd: 'jd',
  ae: 'emailapply', // save the application email (resume attached) to Gmail drafts
} as const;
export type ActionCode = keyof typeof ACTIONS;
export type Action = (typeof ACTIONS)[ActionCode];

export const SKIP_REASONS: Record<string, string> = {
  'skip:scope': 'wrong scope',
  'skip:location': 'location or timing',
  'skip:company': 'company',
  'skip:level': 'level or eligibility',
  'skip:other': 'other',
};

const SIG_LEN = 12;

/** "ap:1z:lx2k9q:abcdefghijkl" = action, id (base36), expiry (unix seconds, base36), signature. Always <= 64 bytes. */
export async function signCallback(secret: string, code: ActionCode, id: number, ttlSeconds: number, nowMs = Date.now()): Promise<string> {
  if (!(code in ACTIONS)) throw new Error(`unknown action ${code}`);
  if (!Number.isInteger(id) || id < 0) throw new Error('id must be a non-negative integer');
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const body = `${code}:${id.toString(36)}:${exp.toString(36)}`;
  const data = `${body}:${(await hmac(secret, `cb|${body}`)).slice(0, SIG_LEN)}`;
  if (te.encode(data).length > 64) throw new Error('callback data over 64 bytes');
  return data;
}

export type VerifiedCallback = { ok: true; action: Action; id: number } | { ok: false; reason: 'format' | 'signature' | 'expired' };

export async function verifyCallback(secret: string, data: string, nowMs = Date.now()): Promise<VerifiedCallback> {
  const parts = String(data || '').split(':');
  if (parts.length !== 4 || !(parts[0] in ACTIONS)) return { ok: false, reason: 'format' };
  const [code, id36, exp36, sig] = parts;
  const body = `${code}:${id36}:${exp36}`;
  const want = (await hmac(secret, `cb|${body}`)).slice(0, SIG_LEN);
  if (!safeEqual(sig, want)) return { ok: false, reason: 'signature' };
  if (parseInt(exp36, 36) * 1000 < nowMs) return { ok: false, reason: 'expired' };
  const id = parseInt(id36, 36);
  if (!Number.isFinite(id)) return { ok: false, reason: 'format' };
  return { ok: true, action: ACTIONS[code as ActionCode], id };
}

// ---------- Dashboard session cookie ----------

export async function signSession(secret: string, ttlSeconds: number, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  return `${exp}.${await hmac(secret, `session|${exp}`)}`;
}

export async function verifySession(secret: string, value: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!value || !secret) return false;
  const [expStr, sig] = value.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !sig || exp * 1000 < nowMs) return false;
  return safeEqual(sig, await hmac(secret, `session|${exp}`));
}

/** SHA-256 hex, used to store one-time login codes without keeping the code itself. */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', te.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
