/** Laptop agent: the next application waiting to be filled. Bearer AGENT_TOKEN. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { agentAuthorized } from '@/src/server/auth';
import { env } from '@/src/server/env';
import { greenhouseFormFor } from '@/src/core/route';
import { jobTypeOf, type Track } from '@/src/core/filters';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sql = await getSql();
  if (await repo.isPaused(sql)) return NextResponse.json({ task: null, paused: true });
  // Email-route applications have no form: they go to Gmail drafts from the Telegram card instead.
  const rows = (await repo.appsInStates(sql, ['ready_to_fill', 'prefilled'])).filter((r) => r.apply_route !== 'email');
  // Agent run id: a filled form lives in the agent's Chrome window, so a restarted agent fills it again (once per run).
  const session = new URL(req.url).searchParams.get('session') ?? '';
  type Attempt = string | { at: string; url: string; session?: string };
  const attempted = (await repo.kvGet<Record<string, Attempt>>(sql, 'agent_attempts')) ?? {};
  // The page the agent opens: a referral link as given; a Greenhouse job as Greenhouse's standalone form.
  const formUrl = (a: repo.AppRow) => a.referral_url || greenhouseFormFor(a.url, a.greenhouse_board) || a.url;
  let next: (typeof rows)[number] | undefined;
  let app: repo.AppRow | null = null;
  for (const r of [...rows].reverse()) {
    const prev = attempted[String(r.id)];
    const a = await repo.getApplication(sql, r.id);
    if (!a) continue;
    const isNew = !prev;
    const linkChanged = typeof prev === 'object' && prev.url !== formUrl(a);
    const reopen = r.state === 'prefilled' && !!session && (typeof prev !== 'object' || prev.session !== session);
    if (isNew || linkChanged || reopen) {
      next = r;
      app = a;
      break;
    }
  }
  if (!next) return NextResponse.json({ task: null });
  const resume = await repo.latestResume(sql, next.id);
  attempted[String(next.id)] = { at: new Date().toISOString(), url: app ? formUrl(app) : next.url, session };
  await repo.kvSet(sql, 'agent_attempts', attempted);
  return NextResponse.json({
    task: {
      applicationId: next.id,
      company: next.company,
      title: next.title,
      // Picks the per-job-type answers in the agent's answer bank (availability_intern, availability_fulltime, ...).
      jobType: app ? jobTypeOf(app.track as Track, app.hours_flag) : 'intern',
      applyUrl: app ? formUrl(app) : next.url,
      resumeUrl: resume ? `${env.appUrl()}/api/agent/resume/${next.id}` : null,
    },
  });
}
