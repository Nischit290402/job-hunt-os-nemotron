import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { agentAuthorized } from '@/src/server/auth';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = Number((await ctx.params).id);
  const r = Number.isInteger(id) ? await repo.latestResume(await getSql(), id) : null;
  if (!r) return NextResponse.json({ error: 'no resume' }, { status: 404 });
  return new Response(Buffer.from(String(r.pdf_base64).replace(/\s/g, ''), 'base64'), {
    headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' },
  });
}
