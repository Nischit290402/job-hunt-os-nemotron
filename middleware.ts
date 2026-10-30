/**
 * Every dashboard page and dashboard API needs a signed session cookie. Machine endpoints authenticate themselves:
 * /api/telegram (secret header), /api/inngest (Inngest signing key), /api/agent and /api/worker (bearer tokens), /api/auth (login flow),
 * /api/cron (bearer CRON_SECRET).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { signSession, verifySession } from './src/core/signing';

// Public demo: machine endpoints of the owner's setup do not exist here.
const DEMO_BLOCKED = /^\/api\/(worker|agent|telegram|inngest)(\/|$)/;

export async function middleware(req: NextRequest) {
  if (DEMO_BLOCKED.test(req.nextUrl.pathname)) {
    // They authenticate themselves (secret header, signing key, bearer tokens); in the public demo they do not exist.
    return process.env.DEMO_MODE === '1' ? new NextResponse('Not found', { status: 404 }) : NextResponse.next();
  }
  const secret = process.env.SIGNING_SECRET ?? '';
  const ok = await verifySession(secret, req.cookies.get('jh_session')?.value);
  if (ok) return NextResponse.next();
  // Public demo is open: no password. Mint a session on the first visit; spend caps in nebius.ts bound the cost.
  if (process.env.DEMO_MODE === '1' && process.env.DEMO_REQUIRE_PASSWORD !== '1' && secret) {
    const ttl = 14 * 86400;
    const value = await signSession(secret, ttl);
    const headers = new Headers(req.headers);
    const rest = (req.headers.get('cookie') ?? '').split(/;\s*/).filter((c) => c && !c.startsWith('jh_session='));
    headers.set('cookie', [...rest, `jh_session=${value}`].join('; '));
    const res = NextResponse.next({ request: { headers } });
    res.cookies.set('jh_session', value, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: ttl });
    return res;
  }
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api/cron|api/auth|login|privacy|_next/static|_next/image|favicon.ico).*)'],
};
