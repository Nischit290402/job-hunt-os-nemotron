/**
 * Durable workflows. Each step.run is its own HTTP invocation (well inside Vercel Hobby's 300 s limit), retried alone,
 * and its result is memoised, so a crash mid-day resumes where it stopped.
 */
import { inngest, EV, emit } from './client';
import { getSql } from '../server/sql';
import * as repo from '../server/repo';
import * as steps from '../server/steps';
import { collectSource, fillDescriptions } from '../server/collector';
import * as worker from '../server/worker';
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

    // Judging runs in your Claude Code scheduled task; the brief uses whatever it has scored by 07:45.
    await step.run('queue-judging', async () => {
      const sql = await getSql();
      const q = await worker.queueJudging(sql, today, env.judgeMaxPerDay());
      return { ...q, fire: q.queued ? (await worker.fire(sql, `judge ${q.queued} new jobs`)).note : 'nothing to judge' };
    });

    await step.sleepUntil('until-brief', sgtAt(today, '07:45'));
    await step.run('build-today', async () => steps.buildToday(await getSql(), today));
    return step.run('send-brief', async () => steps.sendBrief(await getSql(), today));
  }
);

/**
 * Each branch is chosen by re-reading the application's state, never by trusting that an event arrived: a tap can land
 * before the matching waitForEvent starts, and waitForEvent does not see earlier events.
 */
export const applicationFlow = inngest.createFunction(
  { id: 'application-flow', retries: 3, concurrency: { limit: 1, key: 'event.data.applicationId' } },
  { event: EV.apply },
  async ({ event, step }) => {
    const id = Number(event.data.applicationId);
    const today = await step.run('date', () => sgtDate());
    const state = (name: string) => step.run(name, async () => steps.stateOf(await getSql(), id));

    await step.run('tailor', async () => steps.tailor(await getSql(), id));
    if ((await state('state-after-queue-tailor')) === 'tailoring') {
      await step.waitForEvent('wait-resume', { event: EV.resumeDone, timeout: '3h', if: sameApp });
      await step.run('tailor-timeout', async () => steps.tailorTimedOut(await getSql(), id));
    }
    await step.run('find-contact', async () => steps.findContactStep(await getSql(), id, today));

    if ((await state('state-after-contact')) === 'awaiting_send') {
      await step.run('draft', async () => steps.draftStep(await getSql(), id));
      await step.waitForEvent('wait-decision', { event: EV.outreachDecided, timeout: '5d', if: sameApp });
      if ((await state('state-after-decision')) === 'awaiting_send') {
        await step.run('drop-stale-draft', async () => steps.dropStaleDraft(await getSql(), id));
      }
    }
    if ((await state('state-before-wait')) === 'ask_sent') {
      const reply = await step.waitForEvent('wait-reply', { event: EV.replied, timeout: '3d', if: sameApp });
      await step.run('after-wait', async () => steps.afterWait(await getSql(), id, !!reply));
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

/** After a preference change: drop open judgments, queue them for the worker, rebuild Today once it is done. */
export const rejudge = inngest.createFunction({ id: 'rejudge', concurrency: 1 }, { event: EV.rejudge }, async ({ step }) => {
  const today = await step.run('date', () => sgtDate());
  await step.run('requeue', async () => {
    const sql = await getSql();
    await repo.requeueForJudging(sql);
    const q = await worker.queueJudging(sql, today, 200);
    return { ...q, fire: (await worker.fire(sql, `re-judge ${q.queued} jobs after a preference change`)).note };
  });
  await step.waitForEvent('wait-idle', { event: EV.workerIdle, timeout: '2h' });
  return step.run('rebuild-today', async () => steps.buildToday(await getSql(), today));
});

/** Hourly: give up on tasks that used every attempt, and restart the worker if work has waited 30 minutes. */
export const workerWatch = inngest.createFunction({ id: 'worker-watch' }, { cron: 'TZ=Asia/Singapore 17 * * * *' }, async ({ step }) =>
  step.run('watch', async () => worker.watch(await getSql()))
);

export const functions = [dailyRun, applicationFlow, replyWatch, eveningNudge, weeklyReview, rejudge, workerWatch];
