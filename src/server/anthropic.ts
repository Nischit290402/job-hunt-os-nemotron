/**
 * Claude Messages API over plain fetch (no SDK dependency). Forces one tool call so the reply is structured JSON.
 * The monthly input-token cap is checked by callers before each batch (repo.tokensThisMonth).
 */
import { env } from './env';
import { httpPost } from './http';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: object;
}

export interface ToolCallResult<T> {
  input: T;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export class ClaudeError extends Error {}

export async function callTool<T = unknown>(opts: { model: string; system: string; user: string; tool: ToolDef; maxTokens?: number }): Promise<ToolCallResult<T>> {
  const res = await httpPost(
    'https://api.anthropic.com/v1/messages',
    {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      tools: [opts.tool],
      tool_choice: { type: 'tool', name: opts.tool.name },
    },
    { 'x-api-key': env.anthropicKey(), 'anthropic-version': '2023-06-01' },
    90_000
  );
  if (res.status !== 200) throw new ClaudeError(`Claude API ${res.status}: ${res.error ?? res.text.slice(0, 300)}`);
  const data = JSON.parse(res.text);
  const block = (data.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === opts.tool.name);
  if (!block) throw new ClaudeError('Claude did not call the tool');
  return { input: block.input as T, tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0, model: data.model ?? opts.model };
}

/** Plain text reply, used by the coach. */
export async function callText(opts: { model: string; system: string; user: string; maxTokens?: number }): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const res = await httpPost(
    'https://api.anthropic.com/v1/messages',
    { model: opts.model, max_tokens: opts.maxTokens ?? 800, system: opts.system, messages: [{ role: 'user', content: opts.user }] },
    { 'x-api-key': env.anthropicKey(), 'anthropic-version': '2023-06-01' },
    90_000
  );
  if (res.status !== 200) throw new ClaudeError(`Claude API ${res.status}: ${res.error ?? res.text.slice(0, 300)}`);
  const data = JSON.parse(res.text);
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return { text, tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0 };
}
