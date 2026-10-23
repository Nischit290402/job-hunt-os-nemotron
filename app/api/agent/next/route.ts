/** Laptop agent: the next application waiting to be filled. Bearer AGENT_TOKEN. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { agentAuthorized } from '@/src/server/auth';
import { env } from '@/src/server/env';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sql = await getSql();
  if (await repo.isPaused(sql)) return NextResponse.json({ task: null, paused: true });
  const rows = await repo.appsInStates(sql, ['ready_to_fill']);
  const attempted = (await repo.kvGet<Record<string, string>>(sql, 'agent_attempts')) ?? {};
  const next = [...rows].reverse().find((r) => !attempted[String(r.id)]);
  if (!next) return NextResponse.json({ task: null });
  const app = await repo.getApplication(sql, next.id);
  const resume = await repo.latestResume(sql, next.id);
  attempted[String(next.id)] = new Date().toISOString();
  await repo.kvSet(sql, 'agent_attempts', attempted);
  return NextResponse.json({
    task: {
      applicationId: next.id,
      company: next.company,
      title: next.title,
      applyUrl: app?.referral_url || next.url,
      resumeUrl: resume ? `${env.appUrl()}/api/agent/resume/${next.id}` : null,
    },
  });
}
