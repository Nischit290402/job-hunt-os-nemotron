/** Settings page forms: preferences, employer caps, sources, pause, weekly target. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { emit, EV } from '@/src/inngest/client';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const f = await req.formData();
  const op = String(f.get('op') ?? '');
  const v = (k: string) => String(f.get(k) ?? '').trim();
  const sql = await getSql();
  let rejudge = false;
  switch (op) {
    case 'add_pref': {
      const kind = v('kind');
      if (!['rule', 'exclude_term', 'archive_term'].includes(kind) || !v('text')) break;
      await repo.addPreference(sql, kind as 'rule' | 'exclude_term' | 'archive_term', kind === 'rule' ? v('text') : v('text').toLowerCase());
      rejudge = true;
      break;
    }
    case 'drop_pref':
      rejudge = await repo.deactivatePreference(sql, Number(v('id')));
      break;
    case 'set_cap':
      if (v('company')) await repo.setEmployerCap(sql, v('company'), v('cap') === '' ? null : Math.max(0, Number(v('cap'))));
      break;
    case 'toggle_source':
      await repo.setSourceEnabled(sql, v('id'), v('enabled') === 'true');
      break;
    case 'pause':
      await repo.kvSet(sql, 'paused', v('paused') === 'true');
      break;
    case 'set_target': {
      const p = await repo.getProfile(sql);
      await repo.setProfile(sql, p.body, p.outreach_summary, Math.max(1, Number(v('target')) || 5));
      break;
    }
    default:
      return NextResponse.json({ error: 'unknown op' }, { status: 400 });
  }
  await repo.logEvent(sql, 'settings', null, op, 'you', Object.fromEntries([...f.entries()].map(([k, x]) => [k, String(x)])));
  if (rejudge) await emit(EV.rejudge, {});
  return NextResponse.redirect(new URL('/settings', req.url), 303);
}
