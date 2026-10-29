import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import { companyJobs } from '@/src/server/companies';
import { parseCompanyQuery } from '@/src/core/companies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const q = parseCompanyQuery(new URL(req.url).searchParams, 6);
  return NextResponse.json(await companyJobs(await getSql(), id, q.type, q.offset, q.limit), { headers: { 'cache-control': 'no-store' } });
}
