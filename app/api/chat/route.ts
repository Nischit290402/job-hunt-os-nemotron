/** Web chat adapter: JSON ChatRequest in, NDJSON StreamEvents out. The session cookie is checked by middleware. */
import { getSql } from '@/src/server/sql';
import { parseChatRequest, runTurn } from '@/src/agents/orchestrator';
import type { StreamEvent } from '@/src/agents/types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'send JSON' }, { status: 400 });
  }
  const parsed = parseChatRequest(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  let sql: Awaited<ReturnType<typeof getSql>>;
  try {
    sql = await getSql();
  } catch {
    return Response.json({ error: 'the database is not configured' }, { status: 503 });
  }

  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
        } catch {
          open = false; // the client closed the tab; the turn still finishes server-side
        }
      };
      try {
        await runTurn(sql, parsed.req, emit);
      } finally {
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
