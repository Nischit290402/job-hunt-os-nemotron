/** Laptop agent: prose questions it left empty on a form. Claude drafts answers; the agent fetches them and types them in. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { agentAuthorized } from '@/src/server/auth';
import { fire, queueAnswers } from '@/src/server/worker';
import { cleanQuestions } from '@/src/core/worker';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { applicationId?: number; questions?: unknown };
  const id = Number(b.applicationId);
  const questions = cleanQuestions(b.questions);
  const sql = await getSql();
  const app = Number.isInteger(id) ? await repo.getApplication(sql, id) : null;
  if (!app || !['ready_to_fill', 'prefilled'].includes(app.state)) return NextResponse.json({ error: 'no application being filled' }, { status: 409 });
  if (!questions) return NextResponse.json({ error: 'expected questions [{qid: "q1", label, maxLength, required}]' }, { status: 400 });
  // Answers drafted earlier for this application (the form was refilled): reuse them.
  const prev = await repo.latestAnswers(sql, app.id);
  if (prev?.status === 'done') return NextResponse.json({ queued: false, reused: true });
  const queued = await queueAnswers(sql, app, questions);
  if (queued) await fire(sql, `draft form answers for ${app.company}`);
  return NextResponse.json({ queued: !!queued });
}
