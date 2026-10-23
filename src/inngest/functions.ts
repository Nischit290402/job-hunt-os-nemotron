/**
 * Durable workflows. Each step.run is its own HTTP invocation (well inside Vercel Hobby's 300 s limit), retried alone,
 * and its result is memoised, so a crash mid-day resumes where it stopped.
 */
import { inngest, EV, emit } from './client';
import { getSql } from '../server/sql';
import * as repo from '../server/repo';
import * as steps from '../server/steps';
import { collectSource, fillDescriptions } from '../server/collector';
import { judgeBatch } from '../server/judge';
import { env } from '../server/env';
import { sgtAt, sgtDate } from '../core/time';

const sameApp = 'async.data.applicationId == event.data.applicationId';

export const dailyRun = inngest.createFunction(
  { id: 'daily-run', concurrency: 1, retries: 2 },
  { cron: 'TZ=Asia/Singapore 0 5 * * *' },
  async ({ step }) => {
    const today = await step.run('date', () => sgtDate());
    const sources = await step.run('list-sources', async () => (await repo.listSources(await getSql())).map((s) => s.id));
    for (const id of sources) {
      await step.run(`collect-${id}`, async () => collectSource(await getSql(), id, today));
    }
    await step.run('describe', async () => fillDescriptions(await getSql(), today, 40));

    await step.sleepUntil('until-judge', sgtAt(today, '07:00'));
    const batches = Math.ceil(env.judgeMaxPerDay() / env.judgeBatchSize());
    for (let i = 0; i < batches; i++) {
      const r = await step.run(`judge-${i}`, async () => judgeBatch(await getSql(), today, env.judgeBatchSize()));
      if (!r.remaining || r.capped) break;
    }

    await step.sleepUntil('until-brief', sgtAt(today, '07:45'));
    await step.run('build-today', async () => steps.buildToday(await getSql(), today));
    return step.run('send-brief', async () => steps.sendBrief(await getSql(), today));
  }
);

export const applicationFlow = inngest.createFunction(
  { id: 'application-flow', retries: 3, concurrency: { limit: 1, key: 'event.data.applicationId' } },
  { event: EV.apply },
  async ({ event, step }) => {
    const id = Number(event.data.applicationId);
    const today = await step.run('date', () => sgtDate());
    await step.run('tailor', async () => steps.tailor(await getSql(), id));
    const found = await step.run('find-contact', async () => steps.findContactStep(await getSql(), id, today));
    if (found.contact) {
      await step.run('draft', async () => steps.draftStep(await getSql(), id));
      const decided = await step.waitForEvent('wait-decision', { event: EV.outreachDecided, timeout: '5d', if: sameApp });
      if (!decided) {
        await step.run('drop-stale-draft', async () => steps.dropStaleDraft(await getSql(), id));
      } else if (decided.data.decision === 'sent') {
        const reply = await step.waitForEvent('wait-reply', { event: EV.replied, timeout: '3d', if: sameApp });
        await step.run('after-wait', async () => steps.afterWait(await getSql(), id, !!reply));
      }
    }
    await step.run('queue-fill', async () => steps.queueFill(await getSql(), id));
    const submitted = await step.waitForEvent('wait-submit', { event: EV.submitted, timeout: '14d', if: sameApp });
    if (!submitted) await step.run('submit-reminder', async () => steps.remindSubmit(await getSql(), id));
    return { applicationId: id };
  }
);

export const replyWatch = inngest.createFunction({ id: 'reply-watch', retries: 2 }, { cron: 'TZ=Asia/Singapore 30 6 * * *' }, async ({ step }) => {
  const today = await step.run('date', () => sgtDate());
  const r = await step.run('check-replies', async () => steps.checkReplies(await getSql(), today));
  for (const appId of r.replied) await step.run(`emit-${appId}`, () => emit(EV.replied, { applicationId: appId }));
  return r;
});

export const eveningNudge = inngest.createFunction({ id: 'evening-nudge' }, { cron: 'TZ=Asia/Singapore 30 20 * * *' }, async ({ step }) =>
  step.run('nudge', async () => steps.eveningNudge(await getSql(), sgtDate()))
);

export const weeklyReview = inngest.createFunction({ id: 'weekly-review' }, { cron: 'TZ=Asia/Singapore 0 9 * * 0' }, async ({ step }) =>
  step.run('review', async () => steps.weeklyReview(await getSql(), sgtDate()))
);

/** After a preference change: drop open judgments and score again in batches. */
export const rejudge = inngest.createFunction({ id: 'rejudge', concurrency: 1 }, { event: EV.rejudge }, async ({ step }) => {
  const today = await step.run('date', () => sgtDate());
  await step.run('requeue', async () => repo.requeueForJudging(await getSql()));
  for (let i = 0; i < 20; i++) {
    const r = await step.run(`judge-${i}`, async () => judgeBatch(await getSql(), today, env.judgeBatchSize()));
    if (!r.remaining || r.capped) break;
  }
  return step.run('rebuild-today', async () => steps.buildToday(await getSql(), today));
});

export const functions = [dailyRun, applicationFlow, replyWatch, eveningNudge, weeklyReview, rejudge];
