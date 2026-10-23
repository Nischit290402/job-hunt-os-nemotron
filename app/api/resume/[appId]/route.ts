/** Download the latest tailored resume from the dashboard (session-protected by middleware). */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ appId: string }> }) {
  const id = Number((await ctx.params).appId);
  const r = Number.isInteger(id) ? await repo.latestResume(await getSql(), id) : null;
  if (!r) return NextResponse.json({ error: 'no resume' }, { status: 404 });
  return new Response(Buffer.from(String(r.pdf_base64).replace(/\s/g, ''), 'base64'), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="resume_${id}.pdf"`, 'cache-control': 'no-store' },
  });
}
