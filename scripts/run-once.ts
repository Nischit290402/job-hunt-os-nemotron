/** Runs one collect + describe + judge + Today cycle locally, without Inngest. Usage: npm run collect:once [-- --no-judge] [-- --brief] */
import './_env';
import { getSql } from '../src/server/sql';
import * as repo from '../src/server/repo';
import { collectSource, fillDescriptions } from '../src/server/collector';
import { judgeBatch } from '../src/server/judge';
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
  for (let i = 0; i < 8; i++) {
    const r = await judgeBatch(sql, today, 5);
    console.log('judge', r);
    if (!r.remaining || r.capped) break;
  }
}
console.log('today', await buildToday(sql, today));
if (process.argv.includes('--brief')) console.log('brief', await sendBrief(sql, today));
