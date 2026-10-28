/** Runs one collect + describe cycle locally, queues judging for the worker, then builds Today. Usage: npm run collect:once [-- --no-judge] [-- --brief] */
import './_env';
import { getSql } from '../src/server/sql';
import * as repo from '../src/server/repo';
import { collectSource, fillDescriptions } from '../src/server/collector';
import { fire, queueJudging } from '../src/server/worker';
import { buildToday, sendBrief } from '../src/server/steps';
import { sgtDate } from '../src/core/time';

const sql = await getSql();
const today = sgtDate();
for (const s of await repo.listSources(sql)) {
  const r = await collectSource(sql, s.id, today);
  console.log(`${s.id.padEnd(20)} ${r.status.padEnd(9)} listed ${r.listed} kept ${r.kept} new ${r.newJobs} closed ${r.closed} ${r.note}`);
}
console.log('descriptions', await fillDescriptions(sql, today, 40));
if (!process.argv.includes('--no-judge')) {
  const q = await queueJudging(sql, today, 40);
  console.log('judging queued', q, q.queued ? await fire(sql, `judge ${q.queued} new jobs`) : '');
  console.log('Today fills once the worker has judged them: run this again with --no-judge in a few minutes.');
}
console.log('today', await buildToday(sql, today));
if (process.argv.includes('--brief')) console.log('brief', await sendBrief(sql, today));
