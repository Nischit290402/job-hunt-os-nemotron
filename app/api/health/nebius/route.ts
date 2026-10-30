/** Nebius health: configured model IDs, whether a key is set, and the NVIDIA models the key can see. Never a chat call (money rule). */
import { NextResponse } from 'next/server';
import { env, features } from '@/src/server/env';
import { listNvidiaModels } from '@/src/server/nebius';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const configured = { fast: env.modelFast(), reason: env.modelReason(), vision: env.modelVision(), fallback: env.modelFallback() };
  const keySet = features.nebius();
  let available: string[] = [];
  let error: string | undefined;
  if (keySet) {
    try {
      available = await listNvidiaModels();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  // Roles whose configured ID the key cannot see: fix with NEBIUS_MODEL_* env.
  const missing = available.length ? Object.entries(configured).filter(([, id]) => !available.includes(id)).map(([role]) => role) : [];
  return NextResponse.json({ keySet, baseUrl: env.nebiusBaseUrl(), configured, available, missing, error });
}
