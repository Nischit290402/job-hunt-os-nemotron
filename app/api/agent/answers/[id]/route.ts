/** Laptop agent: the drafted answers for an application's open questions, once Claude has written them. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { agentAuthorized } from '@/src/server/auth';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const t = await repo.latestAnswers(await getSql(), id);
  if (!t) return NextResponse.json({ status: 'failed' });
  if (t.status === 'done') return NextResponse.json({ status: 'ready', answers: t.result?.output?.answers ?? [] });
  return NextResponse.json({ status: t.status === 'failed' ? 'failed' : 'pending' });
}
