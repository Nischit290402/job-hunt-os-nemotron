/**
 * The always-on daily run (Vercel Cron 05:00 SGT, also the demo seed): collect a few Greenhouse boards, fill
 * descriptions, Nano triages the new jobs, Ultra re-judges the best few, then Today is rebuilt.
 * Every step fails soft and the summary says what happened; a USD cap stops the model steps, never the run.
 */
import type { Sql } from '../sql';
import * as repo from '../repo';
import { env } from '../env';
import { LlmCapError, llmFor } from '../nebius';
import { collectSource, fillDescriptions } from '../collector';
import { buildToday } from '../steps';
import { judgeJob, triageBatch, type JudgeCtx } from './judge';
import type { LlmClient } from '../../agents/types';

export interface DailyOpts {
  sources?: number;
  triage?: number;
  rejudge?: number;
  deadlineMs?: number; // absolute
  llm?: LlmClient; // injected in tests; production uses llmFor(sql)
}

export interface DailySummary {
  today: string;
  seconds: number;
  sources: { id: string; status: string; listed: number; newJobs: number }[];
  described: { filled: number; unavailable: number } | null;
  triaged: number;
  triageErrors: number;
  rejudged: { jobId: number; nano: number | null; ultra: number; model: string }[];
  today_list: { kept: number; added: number } | null;
  capped: string | null;
  errors: string[];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

const DESCRIBE_MS = 90_000;

export async function runDaily(sql: Sql, today: string, opts: DailyOpts = {}): Promise<DailySummary> {
  const started = Date.now();
  const deadline = opts.deadlineMs ?? started + 270_000;
  const left = () => deadline - Date.now();
  const nSources = opts.sources ?? 6;
  const nTriage = opts.triage ?? 10;
  const nRejudge = opts.rejudge ?? 2;
  const llm = opts.llm ?? llmFor(sql);
  const ctx: JudgeCtx = { sql, llm, today, deadlineMs: deadline };
  const s: DailySummary = { today, seconds: 0, sources: [], described: null, triaged: 0, triageErrors: 0, rejudged: [], today_list: null, capped: null, errors: [] };

  // 1. Collect: the demo's chosen boards, else the first N enabled Greenhouse boards. Free public APIs.
  try {
    const demo = env.demoSourceIds();
    const ids: string[] = demo.length
      ? demo.slice(0, nSources)
      : (await sql`SELECT id FROM sources WHERE enabled AND type = 'greenhouse' ORDER BY id LIMIT ${nSources}`).map((r) => String(r.id));
    const res = await Promise.allSettled(ids.map((id) => collectSource(sql, id, today)));
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') s.sources.push({ id: ids[i], status: r.value.status, listed: r.value.listed, newJobs: r.value.newJobs });
      else s.errors.push(`collect ${ids[i]}: ${msg(r.reason)}`);
    });
  } catch (e) {
    s.errors.push(`collect: ${msg(e)}`);
  }

  // 2. Descriptions. Without Firecrawl or Brave keys this uses plain HTTP only; a failure never stops the run.
  if (left() > 60_000) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((res) => (timer = setTimeout(() => res(null), Math.min(DESCRIBE_MS, left() - 60_000))));
      const r = await Promise.race([fillDescriptions(sql, today, 15), timeout]).finally(() => clearTimeout(timer));
      if (r) s.described = { filled: r.filled, unavailable: r.unavailable };
      else s.errors.push('describe: stopped at its time budget');
    } catch (e) {
      s.errors.push(`describe: ${msg(e)}`);
    }
  }

  // 3. Nano triage of unjudged open jobs.
  const nano = new Map<number, number>();
  if (nTriage > 0 && left() > 20_000) {
    try {
      const jobs = await repo.jobsToJudge(sql, nTriage);
      const t = await triageBatch(ctx, jobs.map((j) => j.id), { concurrency: 4 });
      for (const r of t.results) if (r.score !== null) nano.set(r.jobId, r.score);
      s.triaged = nano.size;
      s.triageErrors = t.results.filter((r) => r.error).length;
      if (t.capped) s.capped = t.capped;
    } catch (e) {
      s.errors.push(`triage: ${msg(e)}`);
    }
  }

  // 4. Ultra re-judges the best Nano scores (this run first, then open jobs no Ultra has judged yet).
  if (!s.capped && nRejudge > 0 && left() > 20_000) {
    const picks = [...nano.entries()].sort((a, b) => b[1] - a[1]).map(([jobId, score]) => ({ jobId, score: score as number | null }));
    if (picks.length < nRejudge) {
      const more = await sql`
        SELECT lj.job_id, lj.score FROM latest_judgments lj JOIN jobs j ON j.id = lj.job_id
        WHERE j.closed_at IS NULL AND j.track <> 'archive' AND lj.model !~* 'ultra' AND lj.verdict <> 'Skip'
        ORDER BY lj.score DESC, lj.job_id LIMIT ${nRejudge * 2}`;
      for (const r of more) if (!picks.some((p) => p.jobId === Number(r.job_id))) picks.push({ jobId: Number(r.job_id), score: Number(r.score) });
    }
    const chosen = picks.slice(0, nRejudge);
    const queue = [...chosen];
    const worker = async () => {
      for (let p = queue.shift(); p && !s.capped; p = queue.shift()) {
        if (left() < 15_000) return;
        try {
          const r = await judgeJob(ctx, p.jobId, 'reason');
          s.rejudged.push({ jobId: p.jobId, nano: p.score, ultra: r.score, model: r.model });
        } catch (e) {
          if (e instanceof LlmCapError) s.capped = e.message;
          else s.errors.push(`rejudge ${p.jobId}: ${msg(e)}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  // 5. Today.
  try {
    const b = await buildToday(sql, today);
    s.today_list = { kept: b.kept, added: b.added };
  } catch (e) {
    s.errors.push(`today: ${msg(e)}`);
  }

  s.seconds = Math.round((Date.now() - started) / 100) / 10;
  await repo
    .recordRun(sql, { step: 'daily', seconds: s.seconds, ok: !s.errors.length && !s.capped, error: s.capped ?? (s.errors[0] || null), detail: s })
    .catch(() => {});
  return s;
}
