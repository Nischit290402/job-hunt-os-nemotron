import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import * as tg from '@/src/server/telegram';
import { hashCode, setSessionCookie } from '@/src/server/auth';

export const runtime = 'nodejs';

const MAX_FAILURES = 5;

export async function POST(req: Request) {
  const sql = await getSql();
  const form = await req.formData();
  const code = String(form.get('code') ?? '').replace(/\D/g, '');
  const failures = (await repo.kvGet<number>(sql, 'login_failures')) ?? 0;
  if (failures >= MAX_FAILURES) {
    // Too many wrong codes: locked until you send /unlock to the Telegram bot.
    return NextResponse.redirect(new URL('/login?error=1', req.url), 303);
  }
  const ok = code.length === 6 && (await repo.consumeLoginCode(sql, await hashCode(code)));
  if (!ok) {
    await repo.kvSet(sql, 'login_failures', failures + 1);
    if (failures + 1 >= MAX_FAILURES) {
      await repo.invalidateLoginCodes(sql);
      await tg.send(`${MAX_FAILURES} wrong dashboard codes in a row. Sign-in is locked. If this was you, send /unlock here, then request a new code.`).catch(() => undefined);
    }
    return NextResponse.redirect(new URL('/login?error=1', req.url), 303);
  }
  await repo.kvSet(sql, 'login_failures', 0);
  await setSessionCookie();
  return NextResponse.redirect(new URL('/', req.url), 303);
}
