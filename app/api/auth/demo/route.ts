/**
 * Public demo sign-in: one shared password (DEMO_PASSWORD), only when DEMO_MODE=1. Wrong passwords are capped at
 * 50 a day across everyone, then the form refuses until the next SGT day. Success sets the normal session cookie.
 */
import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { env } from '@/src/server/env';
import { setSessionCookie } from '@/src/server/auth';
import { sgtDate } from '@/src/core/time';

export const runtime = 'nodejs';

const MAX_FAILURES_PER_DAY = 50;

/** Hashing both sides gives equal-length buffers, so the compare leaks neither the content nor the length. */
function samePassword(given: string, want: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(want, 'utf8').digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!env.demoMode()) return new NextResponse('Not found', { status: 404 });
  const back = (e: string) => NextResponse.redirect(new URL(`/login?e=${e}`, req.url), 303);
  const want = env.demoPassword();
  if (!want) return back('off');

  const sql = await getSql();
  const key = `demo_login_fail_${sgtDate()}`;
  const failures = Number((await repo.kvGet<number>(sql, key)) ?? 0);
  if (failures >= MAX_FAILURES_PER_DAY) return back('limit');

  const form = await req.formData();
  const given = String(form.get('password') ?? '');
  if (!given || !samePassword(given, want)) {
    await repo.kvIncrement(sql, key);
    return back('1');
  }
  await setSessionCookie();
  return NextResponse.redirect(new URL('/chat', req.url), 303);
}
