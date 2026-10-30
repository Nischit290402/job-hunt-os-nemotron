/**
 * One-off live probe of Nebius Token Factory, run once on the laptop before experts are wired to real models.
 * Cheap on purpose: a model list plus 5 tiny calls (max_tokens <= 40). Writes .work/probe.json. Never prints the key.
 * Usage: ENV_FILE=.env.demo npx tsx scripts/probe-nebius.ts
 */
import './_env';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1/').replace(/\/?$/, '/');
const key = process.env.NEBIUS_API_KEY || '';
if (!key) throw new Error('NEBIUS_API_KEY is not set (put it in .env.demo)');
const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const out: Record<string, unknown> = { at: new Date().toISOString() };

async function post(body: object) {
  const t = Date.now();
  const r = await fetch(`${base}chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {}
  const m = j?.choices?.[0]?.message ?? {};
  return {
    status: r.status,
    ms: Date.now() - t,
    model: j?.model,
    content: typeof m.content === 'string' ? m.content.slice(0, 200) : m.content,
    reasoning: (m.reasoning_content ?? m.reasoning ?? '').toString().slice(0, 80),
    toolCalls: m.tool_calls?.map((c: any) => ({ name: c.function?.name, args: String(c.function?.arguments).slice(0, 120) })),
    usage: j?.usage,
    error: r.ok ? undefined : text.slice(0, 300),
  };
}

const models = await fetch(`${base}models`, { headers: H }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
const ids: string[] = (models?.data ?? []).map((m: any) => m.id);
out.nvidia = ids.filter((id) => /nemotron|nvidia/i.test(id));
const pick = (re: RegExp, d: string) => ids.find((id) => re.test(id)) ?? d;
const fast = process.env.NEBIUS_MODEL_FAST || pick(/nemotron-3-nano/i, 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
const reason = process.env.NEBIUS_MODEL_REASON || pick(/nemotron-3-ultra/i, 'nvidia/Nemotron-3-Ultra-550b-a55b');
const vision = process.env.NEBIUS_MODEL_VISION || pick(/vl/i, 'nvidia/Nemotron-3.5-Super-VL');
const fallback = process.env.NEBIUS_MODEL_FALLBACK || pick(/lightning/i, 'nvidia/Nemotron-3_5-Lightning');
out.resolved = { fast, reason, vision, fallback };

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
out.jsonSchema = await post({ model: fast, max_tokens: 30, temperature: 0, messages: [{ role: 'user', content: 'Reply {"ok": true}' }], response_format: { type: 'json_schema', json_schema: { name: 'probe', schema, strict: true } } });
out.jsonObject = await post({ model: fast, max_tokens: 30, temperature: 0, messages: [{ role: 'user', content: 'Reply with JSON {"ok": true} only.' }], response_format: { type: 'json_object' } });
out.tools = await post({
  model: fast, max_tokens: 40, temperature: 0,
  messages: [{ role: 'user', content: 'Call ping with x=1.' }],
  tools: [{ type: 'function', function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] } } }],
  tool_choice: 'required',
});
out.ultraNoThink = await post({ model: reason, max_tokens: 20, temperature: 0, messages: [{ role: 'user', content: 'Say OK.' }], chat_template_kwargs: { enable_thinking: false } });
// 32x32 grey PNG: only proves the vision route accepts an image; the real screenshot is tested in the smoke run.
const png = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAGklEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAB4NwVQAAEJ5uRaAAAAAElFTkSuQmCC';
out.vision = await post({ model: vision, max_tokens: 20, messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is this image? One word.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }] });
out.fallback = await post({ model: fallback, max_tokens: 10, temperature: 0, messages: [{ role: 'user', content: 'Say OK.' }] });

mkdirSync('.work', { recursive: true });
writeFileSync('.work/probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
