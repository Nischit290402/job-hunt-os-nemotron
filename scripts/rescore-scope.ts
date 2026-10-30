/**
 * One-off after widening the role scope (rubric v2.1: SWE and FDE count): drops judgments that failed the old scope
 * gate (A2) on jobs you have not decided, so the worker scores them again. Usage: npx tsx scripts/rescore-scope.ts
 * Then run `npm run collect:once` to pick up listings the old filter skipped and queue all of it for scoring.
 */
import './_env';
import { getSql } from '../src/server/sql';

const sql = await getSql();
const r = await sql`DELETE FROM judgments WHERE job_id IN (
                      SELECT lj.job_id FROM latest_judgments lj JOIN jobs j ON j.id = lj.job_id
                      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = 1
                      WHERE j.closed_at IS NULL AND lj.gates->>'A2' = 'FAIL' AND lj.rubric_version <> 'v2.1'
                        AND (a.id IS NULL OR a.state IN ('today', 'snoozed', 'skipped')))
                    RETURNING job_id`;
console.log(`Cleared ${new Set(r.map((x) => x.job_id)).size} scope-failed scores; they are scored again with the new rubric.`);
