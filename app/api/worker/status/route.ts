/** Open work and how much has waited 10+ minutes. The laptop agent uses this to decide whether to run Claude Code locally. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { workerAuthorized } from '@/src/server/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sql = await getSql();
  return NextResponse.json({ ...(await repo.queueSummary(sql)), paused: await repo.isPaused(sql) });
}
