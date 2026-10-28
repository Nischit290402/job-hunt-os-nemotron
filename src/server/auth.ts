/** Dashboard sign-in: a 6-digit code sent to your Telegram chat, then a signed session cookie. No passwords anywhere. */
import { cookies } from 'next/headers';
import { env } from './env';
import { signSession, verifySession, sha256Hex } from '../core/signing';

export const SESSION_COOKIE = 'jh_session';
export const SESSION_TTL = 14 * 86400;
export const CODE_TTL = 600;

export function newCode(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, '0');
}

export const hashCode = (code: string) => sha256Hex(`login|${env.signingSecret()}|${code}`);

export async function setSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await signSession(env.signingSecret(), SESSION_TTL), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export async function isSignedIn(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(env.signingSecret(), jar.get(SESSION_COOKIE)?.value);
}

/** Bearer check for the laptop agent. Constant-time compare. */
export function agentAuthorized(req: Request): boolean {
  return bearerIs(req, env.agentToken());
}

/** Bearer check for the Claude worker (scheduled task or laptop). */
export function workerAuthorized(req: Request): boolean {
  return bearerIs(req, env.workerToken());
}

function bearerIs(req: Request, token: string): boolean {
  const h = req.headers.get('authorization') ?? '';
  const want = `Bearer ${token}`;
  if (h.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
