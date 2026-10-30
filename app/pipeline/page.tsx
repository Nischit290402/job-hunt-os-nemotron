/** Every job you decided on, as a funnel summary over a dense, filterable list. */
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { PIPELINE_COLUMNS, type AppState } from '@/src/core/state';
import { Verdict } from '../ui';
import s from './pipeline.module.css';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const EMPTY: Record<string, string> = {
  deciding: 'Nothing waiting on a decision. New jobs land here after the daily run.',
  preparing: 'Nothing being prepared. Pick a job to start tailoring.',
  'referral-wait': 'No referral asks waiting on a reply.',
  'ready-to-submit': 'Nothing ready to submit yet.',
  applied: 'No applications sent yet.',
  interview: 'No interviews yet.',
  closed: 'Nothing closed yet.',
  all: 'No active applications. Pick jobs from Today to start.',
};

function href(stage: string, page = 1) {
  const q = new URLSearchParams();
  if (stage !== 'all') q.set('stage', stage);
  if (page > 1) q.set('page', String(page));
  const qs = q.toString();
  return qs ? `/pipeline?${qs}` : '/pipeline';
}

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ stage?: string; page?: string }> }) {
  const sp = await searchParams;
  const cols = PIPELINE_COLUMNS.map((c) => ({ ...c, slug: slug(c.title) }));
  const active = cols.find((c) => c.slug === sp.stage)?.slug ?? 'all';
  const rows = await repo.appsInStates(await getSql(), cols.flatMap((c) => c.states) as AppState[]);

  const stageIndex = (st: AppState) => cols.findIndex((c) => c.states.includes(st));
  const counts = cols.map((c) => rows.filter((r) => c.states.includes(r.state as AppState)).length);
  const shown = cols.filter((c) => (active === 'all' ? c.slug !== 'closed' : c.slug === active)).flatMap((c) => c.states);

  const filtered = rows
    .filter((r) => shown.includes(r.state as AppState))
    .sort((a, b) => stageIndex(a.state as AppState) - stageIndex(b.state as AppState) || (b.score ?? -1) - (a.score ?? -1));

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1));
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const activeTotal = counts.slice(0, -1).reduce((a, b) => a + b, 0);

  return (
    <>
      <h1>Pipeline</h1>
      <p className="muted small">Every job you are tracking, by stage. Open a row to update it, for example after an interview call.</p>

      <nav className={s.funnel} aria-label="Stages">
        <a href={href('all')} className={`${s.seg} ${active === 'all' ? s.segActive : ''}`} aria-current={active === 'all' ? 'page' : undefined}>
          All <span className={s.count}>{activeTotal}</span>
        </a>
        {cols.map((c, i) => (
          <span key={c.slug} style={{ display: 'contents' }}>
            {i > 0 && <span className={s.sep} aria-hidden="true">&gt;</span>}
            <a href={href(c.slug)} className={`${s.seg} ${active === c.slug ? s.segActive : ''}`} aria-current={active === c.slug ? 'page' : undefined}>
              {c.title} <span className={s.count}>{counts[i]}</span>
            </a>
          </span>
        ))}
      </nav>

      <div className={s.meta}>
        <span>
          Showing {slice.length} of {filtered.length}
        </span>
        {pages > 1 && (
          <span>
            Page {page} of {pages}
          </span>
        )}
      </div>

      {slice.length === 0 ? (
        <div className={`${s.list} ${s.empty}`}>{EMPTY[active] ?? EMPTY.all}</div>
      ) : (
        <ul className={s.list}>
          {slice.map((r) => {
            const col = cols[stageIndex(r.state as AppState)];
            return (
              <li className={s.row} key={r.id}>
                <div className={s.who} title={`${r.company} - ${r.title}`}>
                  <span className={s.company}>{r.company}</span> <span className={s.role}>{r.title}</span>
                </div>
                <div className={s.pills}>
                  <Verdict verdict={r.verdict} score={r.score} />
                  <span className={s.stage} title={r.state.replace(/_/g, ' ')}>
                    {col?.title ?? r.state}
                  </span>
                </div>
                <span className={s.when}>{r.applied_at ? r.applied_at.slice(0, 10) : r.updated_at ? r.updated_at.slice(0, 10) : 'today'}</span>
                <a className={s.open} href={`/jobs/${r.job_id}`}>
                  Open
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className={s.pager}>
          {page > 1 ? <a href={href(active, page - 1)}>Prev</a> : <span className={s.disabled}>Prev</span>}
          {page < pages ? <a href={href(active, page + 1)}>Next</a> : <span className={s.disabled}>Next</span>}
        </div>
      )}
    </>
  );
}
