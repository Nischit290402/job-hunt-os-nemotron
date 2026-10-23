/** Every job you decided on, as a board by stage. */
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { PIPELINE_COLUMNS, type AppState } from '@/src/core/state';
import { Verdict } from '../ui';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const rows = await repo.appsInStates(await getSql(), PIPELINE_COLUMNS.flatMap((c) => c.states) as AppState[]);
  return (
    <>
      <h1>Pipeline</h1>
      <p className="muted small">Something happened outside the system, like an interview call? Use /outcome in Telegram or the buttons on the job page.</p>
      <div className="board">
        {PIPELINE_COLUMNS.map((c) => {
          const items = rows.filter((r) => c.states.includes(r.state));
          return (
            <div className="col" key={c.title}>
              <h3>
                {c.title} ({items.length})
              </h3>
              {items.slice(0, c.title === 'Closed' ? 30 : 100).map((r) => (
                <div className="item" key={r.id}>
                  <a href={`/jobs/${r.job_id}`}>{r.company}</a>
                  <div>{r.title}</div>
                  <div className="row">
                    <Verdict verdict={r.verdict} score={r.score} />
                    <span className="muted">{r.state.replace(/_/g, ' ')}</span>
                  </div>
                  {r.skip_reason && <div className="muted">skip: {r.skip_reason}</div>}
                  {r.applied_at && <div className="muted">applied {r.applied_at}</div>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
