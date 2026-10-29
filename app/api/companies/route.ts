import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import { companyOverview } from '@/src/server/companies';
import { parseCompanyQuery } from '@/src/core/companies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = parseCompanyQuery(new URL(req.url).searchParams);
  return NextResponse.json(await companyOverview(await getSql(), q), { headers: { 'cache-control': 'no-store' } });
}
