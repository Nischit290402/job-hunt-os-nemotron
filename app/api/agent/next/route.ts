/** Laptop agent: the next application waiting to be filled. Bearer AGENT_TOKEN. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { agentAuthorized } from '@/src/server/auth';
import { env } from '@/src/server/env';
import { greenhouseFormFor } from '@/src/core/route';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sql = await getSql();
  if (await repo.isPaused(sql)) return NextResponse.json({ task: null, paused: true });
  // Email-route applications have no form: they go to Gmail drafts from the Telegram card instead.
  const rows = (await repo.appsInStates(sql, ['ready_to_fill'])).filter((r) => r.apply_route !== 'email');
  // One attempt per application and link: a new link (official page found, /referral) gets a fresh attempt.
  const attempted = (await repo.kvGet<Record<string, string | { at: string; url: string }>>(sql, 'agent_attempts')) ?? {};
  // The page the agent opens: a referral link as given; a Greenhouse job as Greenhouse's standalone form.
  const formUrl = (a: repo.AppRow) => a.referral_url || greenhouseFormFor(a.url, a.greenhouse_board) || a.url;
  const linkOf = async (id: number) => {
    const a = await repo.getApplication(sql, id);
    return a ? formUrl(a) : '';
  };
  let next: (typeof rows)[number] | undefined;
  for (const r of [...rows].reverse()) {
    const prev = attempted[String(r.id)];
    // An old entry without a link counts as tried; /retry clears it.
    if (!prev || (typeof prev === 'object' && prev.url !== (await linkOf(r.id)))) {
      next = r;
      break;
    }
  }
  if (!next) return NextResponse.json({ task: null });
  const app = await repo.getApplication(sql, next.id);
  const resume = await repo.latestResume(sql, next.id);
  attempted[String(next.id)] = { at: new Date().toISOString(), url: app ? formUrl(app) : next.url };
  await repo.kvSet(sql, 'agent_attempts', attempted);
  return NextResponse.json({
    task: {
      applicationId: next.id,
      company: next.company,
      title: next.title,
      applyUrl: app ? formUrl(app) : next.url,
      resumeUrl: resume ? `${env.appUrl()}/api/agent/resume/${next.id}` : null,
    },
  });
}
