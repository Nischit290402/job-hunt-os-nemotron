/** Worker posts a finished task. A malformed result returns 400 and the task stays claimed so it can be resent. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import { workerAuthorized } from '@/src/server/auth';
import { applyResult, ResultError } from '@/src/server/worker';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { id?: number; result?: unknown } | null;
  const id = Number(b?.id);
  if (!b || !Number.isInteger(id)) return NextResponse.json({ error: 'expected {id, result}' }, { status: 400 });
  try {
    return NextResponse.json(await applyResult(await getSql(), id, b.result));
  } catch (e) {
    if (e instanceof ResultError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
