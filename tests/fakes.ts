/**
 * Shared fakes so no test ever calls Nebius or Tavily (and no test spends credits).
 * fakeChat(script): each call takes the next script entry (an object, or a function of the call).
 */
import type { LlmCall, LlmClient, LlmResult, StreamEvent, TavilyClient, WebResult } from '../src/agents/types';

export function fakeChat(script: (Partial<LlmResult> | ((call: LlmCall) => Partial<LlmResult>))[]): LlmClient & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const fn = (async (call: LlmCall) => {
    calls.push(call);
    const next = script.length > 1 ? script.shift()! : script[0];
    const r = typeof next === 'function' ? next(call) : next ?? {};
    const json = r.json ?? (r.content ? safeParse(r.content) : undefined);
    return {
      content: r.content ?? (json !== undefined ? JSON.stringify(json) : ''),
      json,
      toolCalls: r.toolCalls,
      model: r.model ?? `fake/${call.role}`,
      role: r.role ?? call.role,
      usage: r.usage ?? { in: 10, out: 10 },
      ms: r.ms ?? 1,
      costUsd: r.costUsd ?? 0,
      fallbackUsed: r.fallbackUsed ?? false,
    } satisfies LlmResult;
  }) as LlmClient & { calls: LlmCall[] };
  fn.calls = calls;
  return fn;
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function fakeTavily(o: { search?: (q: string) => WebResult[]; extract?: (url: string) => string } = {}): TavilyClient & { searched: string[]; extracted: string[] } {
  const searched: string[] = [];
  const extracted: string[] = [];
  return {
    searched,
    extracted,
    search: async (q) => {
      searched.push(q);
      return o.search ? o.search(q) : [];
    },
    extract: async (urls) => {
      extracted.push(...urls);
      return urls.map((url) => ({ url, text: o.extract ? o.extract(url) : '' }));
    },
  };
}

export function collect(): { emit: (e: StreamEvent) => void; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return { emit: (e) => events.push(e), events };
}
