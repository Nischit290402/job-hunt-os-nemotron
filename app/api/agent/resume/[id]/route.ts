import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { resumeFileName } from '@/src/core/contacts';
import { sgtDate } from '@/src/core/time';
import { agentAuthorized } from '@/src/server/auth';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = Number((await ctx.params).id);
  const sql = await getSql();
  const r = Number.isInteger(id) ? await repo.latestResume(sql, id) : null;
  if (!r) return NextResponse.json({ error: 'no resume' }, { status: 404 });
  const app = await repo.getApplication(sql, id);
  const name = resumeFileName(app?.company ?? 'Company', app?.title ?? '', sgtDate().slice(0, 4));
  return new Response(Buffer.from(String(r.pdf_base64).replace(/\s/g, ''), 'base64'), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
  });
}
