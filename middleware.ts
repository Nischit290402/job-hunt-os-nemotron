/**
 * Every dashboard page and dashboard API needs a signed session cookie. Machine endpoints authenticate themselves:
 * /api/telegram (secret header), /api/inngest (Inngest signing key), /api/agent and /api/worker (bearer tokens), /api/auth (login flow).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifySession } from './src/core/signing';

export async function middleware(req: NextRequest) {
  const ok = await verifySession(process.env.SIGNING_SECRET ?? '', req.cookies.get('jh_session')?.value);
  if (ok) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api/telegram|api/inngest|api/agent|api/worker|api/auth|login|_next/static|_next/image|favicon.ico).*)'],
};
