/**
 * Sends a one-time dashboard code to your Telegram chat. Only the newest code is valid, at most one code a minute
 * and 10 a day, so guessing is limited to 5 tries per code and 50 a day.
 */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import * as tg from '@/src/server/telegram';
import { CODE_TTL, hashCode, newCode } from '@/src/server/auth';
import { sgtDate } from '@/src/core/time';

export const runtime = 'nodejs';

const MAX_CODES_PER_DAY = 10;

export async function POST(req: Request) {
  const sql = await getSql();
  const last = await repo.kvGet<number>(sql, 'last_login_code_at');
  if (last && Date.now() - last < 60_000) return NextResponse.redirect(new URL('/login?sent=wait', req.url), 303);
  const issued = await repo.kvIncrement(sql, `login_codes_${sgtDate()}`);
  if (issued > MAX_CODES_PER_DAY) return NextResponse.redirect(new URL('/login?sent=limit', req.url), 303);
  const code = newCode();
  await repo.storeLoginCode(sql, await hashCode(code), CODE_TTL); // voids every older code
  await repo.kvSet(sql, 'login_failures', 0); // the failure budget belongs to the live code
  await repo.kvSet(sql, 'last_login_code_at', Date.now());
  await tg.send(`Dashboard sign-in code: <code>${code}</code> (valid 10 minutes). If you did not ask for this, ignore it; send /unlock only if sign-in gets locked.`);
  return NextResponse.redirect(new URL('/login?sent=1', req.url), 303);
}
