/** Sends a one-time dashboard code to your Telegram chat. At most one code a minute. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import * as tg from '@/src/server/telegram';
import { CODE_TTL, hashCode, newCode } from '@/src/server/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const sql = await getSql();
  const last = await repo.kvGet<number>(sql, 'last_login_code_at');
  if (last && Date.now() - last < 60_000) return NextResponse.redirect(new URL('/login?sent=wait', req.url), 303);
  const code = newCode();
  await repo.storeLoginCode(sql, await hashCode(code), CODE_TTL);
  await repo.kvSet(sql, 'last_login_code_at', Date.now());
  await tg.send(`Dashboard sign-in code: <code>${code}</code> (valid 10 minutes). If you did not ask for this, ignore it.`);
  return NextResponse.redirect(new URL('/login?sent=1', req.url), 303);
}
