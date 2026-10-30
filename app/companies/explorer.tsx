'use client';
/**
 * Client side of the Companies page. The first page of companies comes with the HTML; everything else (filters,
 * more companies, a company's jobs) is fetched from /api/companies only when you ask for it.
 */
import { useEffect, useRef, useState } from 'react';
import { jobStatus, TYPE_LABEL, type ViewType } from '@/src/core/companies';
import type { CompanyJobRow, CompanyRow, CompanyTotals } from '@/src/server/companies';

type Page<T> = { rows: T[]; total: number };
type JobsState = Page<CompanyJobRow> & { loading: boolean; error?: string };

const TYPES: { v: ViewType; label: string }[] = [
  { v: '', label: 'All' },
  { v: 'intern', label: 'Intern' },
  { v: 'parttime', label: 'Part-time' },
  { v: 'fulltime', label: 'Full-time' },
];
const SORTS = [
  { v: 'score', label: 'Best fit' },
  { v: 'jobs', label: 'Most jobs' },
  { v: 'recent', label: 'Recently seen' },
  { v: 'name', label: 'Name' },
];
const SEGMENTS: { key: keyof CompanyRow; label: string; cls: string }[] = [
  { key: 'v_now', label: 'Apply now', cls: 'now' },
  { key: 'v_week', label: 'Apply this week', cls: 'week' },
  { key: 'v_watch', label: 'Watch', cls: 'watch' },
  { key: 'v_skip', label: 'Skip', cls: 'skip' },
  { key: 'v_none', label: 'Not scored yet', cls: 'none' },
];
const COMPANY_PAGE = 15;
const JOB_PAGE = 6;

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (s: string) =>
  s.replace(/\b(pte|ltd|limited|inc|llc|singapore|the)\b\.?/gi, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

function ago(date: string | null): string {
  if (!date) return '';
  const days = Math.round((Date.now() - Date.parse(date)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function scoreTone(verdict: string | null): string {
  return verdict === 'Apply now' ? 'now' : verdict === 'Apply this week' ? 'week' : verdict === 'Watch' ? 'watch' : verdict === 'Skip' ? 'skip' : 'none';
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 401 ? 'Signed out. Reload the page.' : `Could not load (HTTP ${r.status}).`);
  return r.json();
}

export default function Explorer({ initial, totals, initialQuery = '' }: { initial: Page<CompanyRow>; totals: CompanyTotals; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [type, setType] = useState<ViewType>('');
  const [sort, setSort] = useState('score');
  const [companies, setCompanies] = useState<Page<CompanyRow>>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [jobs, setJobs] = useState<Record<number, JobsState>>({});
  const first = useRef(true);

  const params = (offset: number, limit: number) => new URLSearchParams({ q, type, sort, offset: String(offset), limit: String(limit) }).toString();

  // Filters changed: reload the first page (search waits for you to stop typing).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        setCompanies(await getJson<Page<CompanyRow>>(`/api/companies?${params(0, COMPANY_PAGE)}`));
        setJobs({});
        setOpen({});
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, q ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, type, sort]);

  async function moreCompanies() {
    setLoading(true);
    setError('');
    try {
      const next = await getJson<Page<CompanyRow>>(`/api/companies?${params(companies.rows.length, COMPANY_PAGE)}`);
      setCompanies((c) => ({ rows: [...c.rows, ...next.rows.filter((r) => !c.rows.some((x) => x.id === r.id))], total: next.total || c.total }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadJobs(id: number, offset: number) {
    setJobs((j) => ({ ...j, [id]: { ...(j[id] ?? { rows: [], total: 0 }), loading: true, error: undefined } }));
    try {
      const page = await getJson<Page<CompanyJobRow>>(`/api/companies/${id}/jobs?${params(offset, JOB_PAGE)}`);
      setJobs((j) => ({ ...j, [id]: { rows: [...(offset ? j[id]?.rows ?? [] : []), ...page.rows], total: page.total, loading: false } }));
    } catch (e) {
      setJobs((j) => ({ ...j, [id]: { ...(j[id] ?? { rows: [], total: 0 }), loading: false, error: (e as Error).message } }));
    }
  }

  function toggle(id: number) {
    const now = !open[id];
    setOpen((o) => ({ ...o, [id]: now }));
    if (now && !jobs[id]) void loadJobs(id, 0);
  }

  const typeTotal = totals.intern + totals.parttime + totals.fulltime || 1;
  const left = companies.total - companies.rows.length;

  return (
    <div className="cx">
      <section className="cx-stats">
        <Stat n={totals.companies} label="companies hiring" />
        <Stat n={totals.jobs} label="open jobs" />
        <Stat n={totals.scored} label="scored" sub={totals.jobs ? `${Math.round((totals.scored / totals.jobs) * 100)}%` : ''} />
        <Stat n={totals.strong} label="strong fits" tone="good" />
        <Stat n={totals.applied} label="applied" tone="accent" />
        <div className="cx-stat cx-mix">
          <div className="cx-mixbar" aria-hidden>
            <span className="t-intern" style={{ width: `${(totals.intern / typeTotal) * 100}%` }} />
            <span className="t-parttime" style={{ width: `${(totals.parttime / typeTotal) * 100}%` }} />
            <span className="t-fulltime" style={{ width: `${(totals.fulltime / typeTotal) * 100}%` }} />
          </div>
          <div className="cx-mixlegend">
            <span><i className="t-intern" />Intern {totals.intern}</span>
            <span><i className="t-parttime" />Part-time {totals.parttime}</span>
            <span><i className="t-fulltime" />Full-time {totals.fulltime}</span>
          </div>
        </div>
      </section>

      <section className="cx-bar">
        <input className="cx-search" type="search" placeholder="Search companies" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search companies" />
        <div className="cx-seg" role="group" aria-label="Job type">
          {TYPES.map((t) => (
            <button key={t.v || 'all'} type="button" className={type === t.v ? 'on' : ''} onClick={() => setType(t.v)}>
              {t.label}
            </button>
          ))}
        </div>
        <label className="cx-sort">
          <span className="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className="cx-legend small muted">
        <span>Fit of each company's jobs:</span>
        {SEGMENTS.map((s) => (
          <span key={s.cls}>
            <i className={`f-${s.cls}`} />
            {s.label}
          </span>
        ))}
      </div>

      {error && <div className="notice">{error}</div>}

      <div className={`cx-list ${loading ? 'busy' : ''}`}>
        {companies.rows.length === 0 && !loading && <p className="muted">No companies match. Clear the search or pick another job type.</p>}
        {companies.rows.map((c) => {
          const j = jobs[c.id];
          const isOpen = !!open[c.id];
          return (
            <article key={c.id} className={`cx-co ${isOpen ? 'open' : ''}`}>
              <button type="button" className="cx-head" onClick={() => toggle(c.id)} aria-expanded={isOpen}>
                <span className="cx-mono" style={{ ['--h' as string]: hue(c.name) }}>
                  {initials(c.name)}
                </span>
                <span className="cx-name">
                  <b>{c.name}</b>
                  <span className="muted small">
                    {c.jobs} job{c.jobs === 1 ? '' : 's'}
                    {c.tier ? ` · tier ${c.tier}` : ''} · seen {ago(c.last_seen)}
                  </span>
                </span>
                <span className="cx-types">
                  {(['intern', 'parttime', 'fulltime'] as const).filter((t) => c[t] > 0).map((t) => (
                    <span key={t} className={`cx-chip t-${t}`}>
                      {TYPE_LABEL[t]} {c[t]}
                    </span>
                  ))}
                </span>
                <span className="cx-fit" title={SEGMENTS.filter((s) => Number(c[s.key]) > 0).map((s) => `${c[s.key]} ${s.label}`).join(', ')}>
                  {SEGMENTS.map((s) =>
                    Number(c[s.key]) > 0 ? <span key={s.cls} className={`f-${s.cls}`} style={{ flexGrow: Number(c[s.key]) }} /> : null
                  )}
                </span>
                <span className={`cx-best f-${c.best == null ? 'none' : c.best >= 75 ? 'now' : c.best >= 60 ? 'week' : c.best >= 45 ? 'watch' : 'skip'}`} title="Best score">
                  {c.best ?? '-'}
                </span>
                <span className="cx-where small">
                  {c.applied > 0 && <span className="pill good">{c.applied} applied</span>}
                  {c.active > 0 && <span className="pill accent">{c.active} in progress</span>}
                  {c.deciding > 0 && <span className="pill">{c.deciding} deciding</span>}
                  {!c.applied && !c.active && !c.deciding && <span className="muted">no applications</span>}
                </span>
                <span className="cx-chev" aria-hidden>
                  ›
                </span>
              </button>

              {isOpen && (
                <div className="cx-body">
                  {!j || (j.loading && !j.rows.length) ? (
                    <div className="cx-skel">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : j.error && !j.rows.length ? (
                    <p className="muted small">{j.error}</p>
                  ) : (
                    <>
                      <table className="cx-jobs">
                        <thead>
                          <tr>
                            <th>Role</th>
                            <th>Type</th>
                            <th>Fit</th>
                            <th>Status</th>
                            <th>Seen</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {j.rows.map((r) => {
                            const st = jobStatus(r.state, !!r.verdict);
                            return (
                              <tr key={r.id}>
                                <td>
                                  <a href={`/jobs/${r.id}`}>{r.title}</a>
                                  <div className="muted small">
                                    {r.location}
                                    {r.app_id ? ` · app ${r.app_id}` : ''}
                                    {r.deadline ? ` · deadline ${r.deadline}` : ''}
                                    {r.closed_at ? ' · posting closed' : ''}
                                  </div>
                                </td>
                                <td>
                                  <span className={`cx-chip t-${r.jtype}`}>{TYPE_LABEL[r.jtype] ?? r.jtype}</span>
                                </td>
                                <td>
                                  <div className="cx-score" title={r.verdict ?? 'Not scored yet'}>
                                    <span className="num">{r.score ?? '-'}</span>
                                    <span className="meter">
                                      <span className={`f-${scoreTone(r.verdict)}`} style={{ width: `${r.score ?? 0}%` }} />
                                    </span>
                                  </div>
                                  <div className="muted small">{r.verdict ?? 'not scored'}</div>
                                </td>
                                <td>
                                  <span className={`pill ${st.tone}`}>{st.label}</span>
                                  {r.applied_at && <div className="muted small">on {r.applied_at}</div>}
                                </td>
                                <td className="small muted">{ago(r.posted ?? r.first_seen)}</td>
                                <td className="small">
                                  {r.apply_route === 'none' ? (
                                    <span className="muted" title="No employer posting or apply email found">no official link</span>
                                  ) : (
                                    <a href={r.url} target="_blank" rel="noreferrer">
                                      Posting ↗
                                    </a>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {j.rows.length < j.total && (
                        <button type="button" className="cx-more" disabled={j.loading} onClick={() => loadJobs(c.id, j.rows.length)}>
                          {j.loading ? 'Loading…' : `View ${Math.min(JOB_PAGE, j.total - j.rows.length)} more jobs (${j.total - j.rows.length} left)`}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {left > 0 && (
        <button type="button" className="cx-more wide" disabled={loading} onClick={moreCompanies}>
          {loading ? 'Loading…' : `Show ${Math.min(COMPANY_PAGE, left)} more companies (${left} left)`}
        </button>
      )}
    </div>
  );
}

function Stat({ n, label, sub, tone }: { n: number; label: string; sub?: string; tone?: 'good' | 'accent' }) {
  return (
    <div className={`cx-stat ${tone ?? ''}`}>
      <div className="n">
        {n}
        {sub && <span className="sub"> {sub}</span>}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}
