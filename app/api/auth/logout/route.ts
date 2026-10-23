import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/src/server/auth';

export async function POST(req: Request) {
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login', req.url), 303);
}
