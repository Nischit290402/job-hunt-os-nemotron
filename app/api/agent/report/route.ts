/** Laptop agent reports a filled (or failed) form. It never submits; you click Submit in the browser it left open. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import * as tg from '@/src/server/telegram';
import { agentAuthorized } from '@/src/server/auth';
import { readyCard, escapeHtml } from '@/src/core/brief';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { applicationId?: number; status?: string; note?: string; filled?: number; missing?: string[] };
  const id = Number(b.applicationId);
  const sql = await getSql();
  const app = Number.isInteger(id) ? await repo.getApplication(sql, id) : null;
  if (!app || !['ready_to_fill', 'prefilled'].includes(app.state)) return NextResponse.json({ error: 'not waiting to be filled' }, { status: 409 });
  const refill = app.state === 'prefilled'; // the agent restarted and filled the form again
  if (b.status === 'prefilled') {
    if (!refill) await repo.applyEvent(sql, id, 'prefill.done', 'system', { note: b.note });
    const missing = (b.missing ?? []).slice(0, 8);
    await tg.send(await readyCard({ applicationId: id, company: app.company, title: app.title, state: 'prefilled', applyUrl: app.referral_url || app.url }, tg.signer));
    if (missing.length) await tg.send(`Fields left for you on ${escapeHtml(app.company)}: ${missing.map(escapeHtml).join(', ')}`);
  } else {
    if (!refill) await repo.applyEvent(sql, id, 'prefill.failed', 'system', { note: b.note });
    await tg.send(`The agent could not fill <b>${escapeHtml(app.company)}</b> (${escapeHtml(b.note ?? 'unknown form')}). Apply by hand, then tap "I submitted it".`);
  }
  return NextResponse.json({ ok: true });
}
