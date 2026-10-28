/** Worker claims up to `limit` tasks, most urgent first. Bearer WORKER_TOKEN. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { workerAuthorized } from '@/src/server/auth';
import { TASK_KINDS, toView, type TaskKind } from '@/src/core/worker';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { runner?: string; limit?: number; kind?: string };
  const limit = Math.max(1, Math.min(20, Number(b.limit) || 5));
  const runner = String(b.runner ?? 'cloud').slice(0, 40);
  const sql = await getSql();
  const kind = (TASK_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as TaskKind) : undefined;
  const tasks = await repo.claimTasks(sql, runner, limit, kind);
  return NextResponse.json({ tasks: tasks.map(toView), paused: await repo.isPaused(sql) });
}
