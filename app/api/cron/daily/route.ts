/**
 * Vercel Cron, 05:00 SGT: the always-on daily run. Only callers with Authorization: Bearer CRON_SECRET get through;
 * an empty secret locks the route.
 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '../../../../src/server/env';
import { getSql } from '../../../../src/server/sql';
import { runDaily } from '../../../../src/server/nemotron/daily';
import { sgtDate } from '../../../../src/core/time';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = env.cronSecret();
  if (!secret) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const started = Date.now();
  const summary = await runDaily(await getSql(), sgtDate(), { sources: 6, triage: 10, rejudge: 2, deadlineMs: started + 270_000 });
  return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
