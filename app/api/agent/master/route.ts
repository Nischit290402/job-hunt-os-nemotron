/** Laptop agent pushes both master resume files, plus the bases and gate scripts, when any of them change. Bearer AGENT_TOKEN. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import * as tg from '@/src/server/telegram';
import { agentAuthorized } from '@/src/server/auth';
import { sha256Hex } from '@/src/core/signing';
import { masterSyncNote, validMaster, type MasterCopy } from '@/src/core/master';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const m = await repo.kvGet<MasterCopy>(await getSql(), 'master_resume');
  return NextResponse.json({ sha: m?.sha ?? null, syncedAt: m?.syncedAt ?? null });
}

export async function POST(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = await req.json().catch(() => null);
  if (!validMaster(b)) return NextResponse.json({ error: 'expected vault and tagged master text' }, { status: 400 });
  const sql = await getSql();
  const prev = await repo.kvGet<MasterCopy>(sql, 'master_resume');
  const next: MasterCopy = {
    vault: b.vault,
    tagged: b.tagged,
    vaultModified: b.vaultModified,
    taggedModified: b.taggedModified,
    files: b.files ?? prev?.files ?? {},
    sha: await sha256Hex(`${b.vault}\u0000${b.tagged}\u0000${JSON.stringify(b.files ?? prev?.files ?? {})}`),
    syncedAt: new Date().toISOString(),
  };
  const note = masterSyncNote(prev, next);
  if (note) {
    await repo.kvSet(sql, 'master_resume', next);
    await tg.send(note).catch(() => undefined);
  }
  return NextResponse.json({ changed: !!note, sha: next.sha });
}
