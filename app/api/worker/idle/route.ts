/** Worker reports the queue is empty at the end of a run. */
import { NextResponse } from 'next/server';
import { workerAuthorized } from '@/src/server/auth';
import { emit, EV } from '@/src/inngest/client';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await repo.kvSet(await getSql(), 'worker_idle_at', Date.now()); // lets the next task start a fresh run at once
  await emit(EV.workerIdle, {}).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
