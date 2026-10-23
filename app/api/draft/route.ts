/** Edit a referral draft from the Job page. Sending still goes through the Send button. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const form = await req.formData();
  const appId = Number(form.get('appId'));
  const body = String(form.get('body') ?? '').trim();
  const sql = await getSql();
  const draft = Number.isInteger(appId) ? await repo.latestDraft(sql, appId) : null;
  if (!draft || !body) return NextResponse.json({ error: 'no draft or empty body' }, { status: 400 });
  await repo.updateDraftBody(sql, draft.id, body.slice(0, 4000));
  await repo.logEvent(sql, 'message', draft.id, 'draft.edited', 'you');
  const back = String(form.get('back') ?? '/');
  return NextResponse.redirect(new URL(back.startsWith('/') ? back : '/', req.url), 303);
}
