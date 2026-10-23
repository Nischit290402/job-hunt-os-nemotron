import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import * as tg from '@/src/server/telegram';
import { hashCode, setSessionCookie } from '@/src/server/auth';

export const runtime = 'nodejs';

const MAX_TRIES_PER_CODE = 5;

export async function POST(req: Request) {
  const sql = await getSql();
  const form = await req.formData();
  const code = String(form.get('code') ?? '').replace(/\D/g, '');
  // Count the try before checking it, atomically, so parallel requests cannot all see "0 failures".
  const tries = await repo.kvIncrement(sql, 'login_failures');
  if (tries > MAX_TRIES_PER_CODE) {
    if (tries === MAX_TRIES_PER_CODE + 1) {
      await repo.invalidateLoginCodes(sql);
      await tg.send('Too many wrong dashboard codes. The current code is cancelled; request a new one on the login page.').catch(() => undefined);
    }
    return NextResponse.redirect(new URL('/login?error=1', req.url), 303);
  }
  const ok = code.length === 6 && (await repo.consumeLoginCode(sql, await hashCode(code)));
  if (!ok) return NextResponse.redirect(new URL('/login?error=1', req.url), 303);
  await repo.kvSet(sql, 'login_failures', 0);
  await setSessionCookie();
  return NextResponse.redirect(new URL('/', req.url), 303);
}
