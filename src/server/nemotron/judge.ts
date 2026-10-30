/**
 * The job judge on Nemotron: rubric v2.1 prompt from core/judge, one structured call, verdict computed in code, saved
 * with the real model ID that answered. 'reason' (Ultra, thinking on) for single jobs and the daily top picks,
 * 'fast' (Nano) for triage.
 */
import type { Sql } from '../sql';
import * as repo from '../repo';
import { LlmCapError } from '../nebius';
import { buildSystemPrompt, buildUserMessage, JUDGE_TOOL, normalizeJudgment, RUBRIC_VERSION, type JudgeInput, type JudgeOutput } from '../../core/judge';
import type { LlmClient, LlmResult, StreamEvent } from '../../agents/types';

export interface JudgeCtx {
  sql: Sql;
  llm: LlmClient;
  emit?: (e: StreamEvent) => void;
  today: string;
  deadlineMs?: number; // absolute; the call timeout never runs past it
}

export interface JudgeResult {
  jobId: number;
  score: number;
  verdict: JudgeOutput['verdict'];
  model: string;
  judgment: JudgeOutput;
  costUsd: number;
}

const SKIPS_SHOWN = 10;

/** Pulls the first JSON object out of a reply, for models that wrap it in prose or a code fence. */
export function parseJsonLoose(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}

export function jsonOf(r: LlmResult): unknown {
  return r.json !== undefined ? r.json : parseJsonLoose(r.content);
}

export async function judgeJob(ctx: JudgeCtx, jobId: number, role: 'reason' | 'fast', opts: { label?: string } = {}): Promise<JudgeResult> {
  const { sql } = ctx;
  const j = await repo.jobToJudgeById(sql, jobId);
  if (!j) throw new Error(`job ${jobId} not found`);
  const profile = await repo.getProfile(sql);
  const prefs = await repo.preferenceBundle(sql);
  const input: JudgeInput = {
    jobId: j.id,
    company: j.company,
    title: j.title,
    location: j.location,
    track: j.track,
    startWindow: j.start_window,
    hoursFlag: j.hours_flag,
    eligFlag: j.elig_flag,
    knownContacts: await repo.connectionNamesByCompany(sql, j.company_key),
    jdText: j.jd_text ?? '',
    fullTimeWanted: (await repo.jobTypes(sql)).includes('fulltime'),
  };
  const system = buildSystemPrompt(profile.body, prefs.rules, prefs.skips.slice(-SKIPS_SHOWN));
  const reason = role === 'reason';
  const base = reason ? 120_000 : 45_000;
  const timeoutMs = ctx.deadlineMs ? Math.max(5_000, Math.min(base, ctx.deadlineMs - Date.now())) : base;
  const r = await ctx.llm({
    role,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${buildUserMessage(input)}\n\nAnswer with the ${JUDGE_TOOL.name} JSON object only.` },
    ],
    schema: { name: JUDGE_TOOL.name, schema: JUDGE_TOOL.input_schema },
    thinking: reason,
    maxTokens: reason ? 1200 : 600,
    temperature: 0,
    timeoutMs,
    tag: { expert: 'job_fetcher', step: reason ? 'judge' : 'triage' },
    label: opts.label,
    emit: ctx.emit,
  });
  const judgment = normalizeJudgment(jsonOf(r), input, ctx.today);
  await repo.saveJudgment(sql, jobId, j.jd_hash, judgment, r.model, RUBRIC_VERSION);
  return { jobId, score: judgment.score, verdict: judgment.verdict, model: r.model, judgment, costUsd: r.costUsd };
}

export interface TriageOutcome {
  results: { jobId: number; score: number | null; verdict: string; model: string; error?: string }[];
  capped: string | null; // the cap message when the USD cap stopped the batch
}

/** Nano triage of many jobs, `concurrency` at a time. A cap stops new calls; any other failure skips that job only. */
export async function triageBatch(ctx: JudgeCtx, jobIds: number[], o: { concurrency?: number } = {}): Promise<TriageOutcome> {
  const out: TriageOutcome = { results: [], capped: null };
  const queue = [...jobIds];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined && !out.capped; id = queue.shift()) {
      if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - 5_000) return;
      try {
        const r = await judgeJob(ctx, id, 'fast');
        out.results.push({ jobId: id, score: r.score, verdict: r.verdict, model: r.model });
      } catch (e) {
        if (e instanceof LlmCapError) out.capped = e.message;
        else out.results.push({ jobId: id, score: null, verdict: '', model: '', error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return out;
}
