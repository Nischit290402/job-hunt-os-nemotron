/** Download the latest tailored resume from the dashboard (session-protected by middleware). */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { resumeFileName } from '@/src/core/contacts';
import { sgtDate } from '@/src/core/time';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ appId: string }> }) {
  const id = Number((await ctx.params).appId);
  const sql = await getSql();
  const r = Number.isInteger(id) ? await repo.latestResume(sql, id) : null;
  if (!r) return NextResponse.json({ error: 'no resume' }, { status: 404 });
  const app = await repo.getApplication(sql, id);
  const name = resumeFileName(app?.company ?? 'Company', app?.title ?? '', sgtDate().slice(0, 4));
  return new Response(Buffer.from(String(r.pdf_base64).replace(/\s/g, ''), 'base64'), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${name}"`, 'cache-control': 'no-store' },
  });
}
