/** Dashboard buttons. The middleware has already checked the session cookie. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import { handleAction } from '@/src/server/actions';
import { ACTIONS, type Action } from '@/src/core/signing';
import { sgtDate } from '@/src/core/time';

export const runtime = 'nodejs';

const ALLOWED = new Set<string>(Object.values(ACTIONS).filter((a) => a !== 'edit'));

export async function POST(req: Request) {
  const form = await req.formData();
  const action = String(form.get('action') ?? '');
  const id = Number(form.get('id'));
  const back = String(form.get('back') ?? '/');
  if (!ALLOWED.has(action) || !Number.isInteger(id)) return NextResponse.json({ error: 'bad action' }, { status: 400 });
  const r = await handleAction(await getSql(), action as Action, id, sgtDate());
  const url = new URL(back.startsWith('/') ? back : '/', req.url);
  url.searchParams.set('msg', r.text.replace(/<[^>]+>/g, '').slice(0, 300));
  return NextResponse.redirect(url, 303);
}
