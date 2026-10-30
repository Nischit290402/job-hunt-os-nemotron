/**
 * Nebius Token Factory client (OpenAI-compatible). Every LLM call in this branch goes through chat().
 * Stub from W0: sub-agent A fills the bodies. Signatures are the contract the experts code against.
 */
import type { Sql } from './sql';
import type { BudgetMode, LlmCall, LlmClient, LlmResult } from '../agents/types';

export class LlmCapError extends Error {}

export async function chat(_sql: Sql, _call: LlmCall): Promise<LlmResult> {
  throw new Error('nebius.chat not built yet');
}

/** chat() bound to a database handle, as experts receive it in ExpertCtx.llm. */
export const llmFor = (sql: Sql): LlmClient => (call) => chat(sql, call);

/** 'saver' at 60% of the daily USD cap (reason calls run on Nano), 'stopped' at either cap (no model calls). */
export async function budgetMode(_sql: Sql, _today: string): Promise<BudgetMode> {
  return 'normal';
}

export interface SpendSummary {
  todayUsd: number;
  totalUsd: number;
  calls: number;
  byRole: Record<string, number>;
  dailyCapUsd: number;
  totalCapUsd: number;
}

export async function spendSummary(_sql: Sql, _today: string): Promise<SpendSummary> {
  return { todayUsd: 0, totalUsd: 0, calls: 0, byRole: {}, dailyCapUsd: 0, totalCapUsd: 0 };
}
