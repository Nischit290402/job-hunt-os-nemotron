/** Preferences, employer caps, sources, pause switch, run history and spend. */
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { sgtDate } from '@/src/core/time';
import { features } from '@/src/server/env';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const sql = await getSql();
  const today = sgtDate();
  const [prefs, caps, sources, runs, fc, queue, profile, paused] = await Promise.all([
    repo.listPreferences(sql),
    repo.employerCaps(sql),
    repo.listSources(sql, false),
    repo.recentRuns(sql),
    repo.firecrawlCredits(sql, today),
    repo.queueSummary(sql),
    repo.getProfile(sql),
    repo.isPaused(sql),
  ]);
  const feat = { Gmail: features.gmail(), 'Brave search': features.brave(), 'Hunter email finder': features.hunter(), Firecrawl: features.firecrawl(), 'Claude scheduled task': features.routine() };

  return (
    <>
      <h1>Settings and health</h1>

      <h2>Outward actions</h2>
      <form action="/api/settings" method="post" className="row">
        <input type="hidden" name="op" value="pause" />
        <input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
        <span>{paused ? 'Paused: no emails go out.' : 'Active.'}</span>
        <button type="submit">{paused ? 'Resume' : 'Pause everything'}</button>
      </form>
      <form action="/api/settings" method="post" className="row" style={{ marginTop: 8 }}>
        <input type="hidden" name="op" value="set_target" />
        <span>Weekly application target</span>
        <input name="target" type="number" min={1} max={50} defaultValue={profile.weekly_target} style={{ width: 80 }} />
        <button type="submit">Save</button>
      </form>
      <p className="small muted">
        Connected: {Object.entries(feat).map(([k, v]) => `${k} ${v ? 'yes' : 'no'}`).join(' · ')}
      </p>

      <h2>Preferences</h2>
      <p className="small muted">Rules go to the judge. Exclude terms remove titles before judging. Every change re-scores open jobs.</p>
      <table>
        <tbody>
          {prefs.filter((p) => p.kind !== 'skip_feedback').map((p) => (
            <tr key={p.id}>
              <td>{p.kind}</td>
              <td>{p.text}</td>
              <td>
                <form action="/api/settings" method="post">
                  <input type="hidden" name="op" value="drop_pref" />
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit">Remove</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action="/api/settings" method="post" className="row" style={{ marginTop: 8 }}>
        <input type="hidden" name="op" value="add_pref" />
        <select name="kind" defaultValue="rule">
          <option value="rule">rule</option>
          <option value="exclude_term">exclude term</option>
          <option value="archive_term">archive term</option>
        </select>
        <input name="text" placeholder="e.g. Core ML or LLM engineering only" style={{ flex: 1, minWidth: 240 }} />
        <button type="submit">Add</button>
      </form>

      <h2>Employer caps</h2>
      <table>
        <tbody>
          {caps.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>
                {c.used} of {c.employer_cap} used
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action="/api/settings" method="post" className="row" style={{ marginTop: 8 }}>
        <input type="hidden" name="op" value="set_cap" />
        <input name="company" placeholder="Company" />
        <input name="cap" type="number" min={0} placeholder="Cap (blank = none)" style={{ width: 160 }} />
        <button type="submit">Set</button>
      </form>

      <h2>Spend</h2>
      <p>
        Firecrawl: {fc.today} today, {fc.month} this month, {fc.total} total. Claude queue:{' '}
        {Object.entries(queue.open).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty'}
        {queue.stale ? `, ${queue.stale} waiting 10+ minutes` : ''}.
      </p>

      <h2>Sources</h2>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Type</th>
            <th>Last status</th>
            <th>Count</th>
            <th>Last ok</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>
                {s.company}
                <div className="small muted">{s.id}</div>
              </td>
              <td>{s.type}</td>
              <td className="small">{s.last_status ?? '-'}</td>
              <td>{s.last_count ?? '-'}</td>
              <td className="small">{s.last_ok_at ? s.last_ok_at.slice(0, 16) : '-'}</td>
              <td>
                <form action="/api/settings" method="post">
                  <input type="hidden" name="op" value="toggle_source" />
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="enabled" value={s.enabled ? 'false' : 'true'} />
                  <button type="submit">{s.enabled ? 'Disable' : 'Enable'}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent runs</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Step</th>
            <th>Seconds</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={i}>
              <td className="small">{r.started_at.slice(0, 16)}</td>
              <td>
                {r.step}
                {r.source_id ? ` · ${r.source_id}` : ''}
              </td>
              <td>{Number(r.seconds ?? 0).toFixed(1)}</td>
              <td className="small">{r.ok ? <span className="badge good">ok</span> : <span className="badge bad">{r.error?.slice(0, 120) ?? 'failed'}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
