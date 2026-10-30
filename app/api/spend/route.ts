/** Spend footer data: today's and all-time Nebius USD, call counts by role, caps and the current budget mode. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import { budgetMode, spendSummary } from '@/src/server/nebius';
import { sgtDate } from '@/src/core/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sql = await getSql();
  const today = sgtDate();
  const [summary, mode] = await Promise.all([spendSummary(sql, today), budgetMode(sql, today)]);
  return NextResponse.json({ ...summary, mode });
}
