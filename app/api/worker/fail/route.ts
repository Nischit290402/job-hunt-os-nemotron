/** Worker gives up on a task. It is retried (up to 3 attempts), then the waiting flow moves on. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import { workerAuthorized } from '@/src/server/auth';
import { applyFailure } from '@/src/server/worker';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { id?: number; error?: string } | null;
  const id = Number(b?.id);
  if (!b || !Number.isInteger(id)) return NextResponse.json({ error: 'expected {id, error}' }, { status: 400 });
  return NextResponse.json(await applyFailure(await getSql(), id, String(b.error ?? 'no reason given')));
}
