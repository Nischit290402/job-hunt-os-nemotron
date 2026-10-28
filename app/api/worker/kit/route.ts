/** The resume kit for tailoring: both master files plus bases and gate scripts, as synced from your laptop. */
import { NextResponse } from 'next/server';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { workerAuthorized } from '@/src/server/auth';
import type { MasterCopy } from '@/src/core/master';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const m = await repo.kvGet<MasterCopy>(await getSql(), 'master_resume');
  if (!m) return NextResponse.json({ error: 'no resume kit yet: run "npm run sync-master" in agent/ on your laptop' }, { status: 404 });
  return NextResponse.json({ vault: m.vault, tagged: m.tagged, files: m.files ?? {}, vaultModified: m.vaultModified, syncedAt: m.syncedAt });
}
