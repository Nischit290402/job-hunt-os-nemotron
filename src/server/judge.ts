/** Judge runner: scores up to `n` queued jobs with the Claude API and stores the judgments. */
import type { Sql } from './sql';
import * as repo from './repo';
import { env } from './env';
import { callTool } from './anthropic';
import { buildSystemPrompt, buildUserMessage, JUDGE_TOOL, normalizeJudgment, RUBRIC_VERSION, type JudgeInput } from '../core/judge';

export async function judgeBatch(sql: Sql, today: string, n: number): Promise<{ judged: number; failed: number; remaining: boolean; capped: boolean }> {
  const started = Date.now();
  const used = await repo.tokensThisMonth(sql, today);
  if (used.in >= env.monthlyTokenCap()) {
    await repo.recordRun(sql, { step: 'judge', seconds: 0, ok: false, error: `monthly token cap ${env.monthlyTokenCap()} reached` });
    return { judged: 0, failed: 0, remaining: false, capped: true };
  }
  const jobs = await repo.jobsToJudge(sql, n + 1);
  const batch = jobs.slice(0, n);
  const profile = await repo.getProfile(sql);
  const prefs = await repo.preferenceBundle(sql);
  const system = buildSystemPrompt(profile.body, prefs.rules, prefs.skips);
  let judged = 0;
  let failed = 0;
  let tin = 0;
  let tout = 0;
  const errors: string[] = [];
  for (const j of batch) {
    const input: JudgeInput = {
      jobId: j.id, company: j.company, title: j.title, location: j.location, track: j.track, startWindow: j.start_window,
      hoursFlag: j.hours_flag, eligFlag: j.elig_flag, knownContacts: await repo.connectionNamesByCompany(sql, j.company_key), jdText: j.jd_text,
    };
    try {
      const r = await callTool({ model: env.judgeModel(), system, user: buildUserMessage(input), tool: JUDGE_TOOL, maxTokens: 700 });
      tin += r.tokensIn;
      tout += r.tokensOut;
      await repo.saveJudgment(sql, j.id, j.jd_hash, normalizeJudgment(r.input, input, today), r.model, RUBRIC_VERSION);
      judged++;
    } catch (e) {
      failed++;
      errors.push(`${j.company} ${j.title}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  await repo.recordRun(sql, {
    step: 'judge', seconds: (Date.now() - started) / 1000, ok: failed === 0, error: errors.join(' | ') || null,
    tokensIn: tin, tokensOut: tout, detail: { judged, failed },
  });
  return { judged, failed, remaining: jobs.length > n, capped: false };
}
