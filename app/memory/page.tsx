/**
 * Read-only view of the user-controlled data: what each expert sees and never sees, what is stored, and the controls.
 * Counts only. The master resume text, contacts and drafts are never rendered here.
 */
import { getSql, type Sql } from '@/src/server/sql';
import { env } from '@/src/server/env';
import { sgtDate } from '@/src/core/time';
import { jobFetcher } from '@/src/agents/jobFetcher';
import { resume } from '@/src/agents/resume';
import { outreach } from '@/src/agents/outreach';
import type { Expert } from '@/src/agents/types';
import s from './memory.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Memory and control - Job Hunt OS' };

interface Slice {
  name: string;
  purpose: string;
  sees: string[];
  neverSees: string[];
  models: string[];
  tools: string[];
}

type Fallback = Omit<Slice, 'name'>;

const FALLBACK: Record<'job_fetcher' | 'resume' | 'outreach', Fallback> = {
  job_fetcher: {
    purpose: 'Reads a lead (screenshot, link or text), finds the full posting, judges it against your rubric, and ranks what is open.',
    sees: ['rubric v2.1', 'your profile', 'your preference rules', 'your last 10 skip reasons'],
    neverSees: ['your master resume', 'contacts', 'drafts'],
    models: [`${env.modelVision()} (reads screenshots)`, `${env.modelFast()} (triage)`, `${env.modelReason()} (judge)`],
    tools: ['Tavily extract (never LinkedIn)', 'Tavily search (LinkedIn excluded)', 'public job boards'],
  },
  resume: {
    purpose: 'Tailors a one-page resume for one job from your master resume, then checks it in code and revises at most once.',
    sees: ['your master resume', 'the one job'],
    neverSees: ['contacts', 'preferences', 'scores', 'other jobs'],
    models: [`${env.modelReason()} (drafts)`, `${env.modelFast()} (fallback, marked)`],
    tools: ['code gates (facts, numbers, one page)', 'PDF render'],
  },
  outreach: {
    purpose: 'Finds one real person at the company on a public page, or uses the one you named, then drafts a referral ask. Nothing is sent.',
    sees: ['your 5-line outreach summary', 'the one job', 'known contacts at that company', 'the person you named, if any'],
    neverSees: ['your full master resume', 'scores', 'other jobs'],
    models: [`${env.modelFast()} (picks candidates)`, `${env.modelReason()} (writes the draft)`],
    tools: ['Tavily search (LinkedIn excluded)', 'Tavily extract (never LinkedIn)'],
  },
};

/** Use the expert's own description; fall back field by field while an expert is still a stub. */
function sliceOf(name: string, expert: Expert, fb: Fallback): Slice {
  let d: ReturnType<Expert['describe']> | null = null;
  try {
    d = expert.describe();
  } catch {
    d = null;
  }
  if (!d || d.sees.length === 0) return { name, ...fb };
  return {
    name,
    purpose: d.purpose || fb.purpose,
    sees: d.sees,
    neverSees: d.neverSees.length ? d.neverSees : fb.neverSees,
    models: d.models.length ? d.models : fb.models,
    tools: d.tools.length ? d.tools : fb.tools,
  };
}

async function safe<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

interface Counts {
  openJobs: number | null;
  judgedJobs: number | null;
  appStates: { state: string; n: number }[] | null;
  resumeVersions: number | null;
  contacts: number | null;
  drafts: number | null;
  masterStored: boolean | null;
  rules: number | null;
  llm: { callsToday: number; usdToday: number; callsTotal: number; usdTotal: number } | null;
}

async function loadCounts(sql: Sql | null, today: string): Promise<Counts> {
  const one = async (q: (sql: Sql) => Promise<{ n: number }[]>): Promise<number | null> =>
    sql ? safe(async () => Number((await q(sql))[0]?.n ?? 0)) : null;

  const [openJobs, judgedJobs, appStates, resumeVersions, contacts, drafts, masterStored, rules, llm] = await Promise.all([
    one((q) => q<{ n: number }>`SELECT count(*)::int AS n FROM jobs WHERE closed_at IS NULL`),
    one((q) => q<{ n: number }>`SELECT count(DISTINCT job_id)::int AS n FROM judgments`),
    sql
      ? safe(async () => {
          const rows = await sql<{ state: string; n: number }>`SELECT state, count(*)::int AS n FROM applications GROUP BY state ORDER BY count(*) DESC, state`;
          return rows.map((r) => ({ state: String(r.state), n: Number(r.n) }));
        })
      : null,
    one((q) => q<{ n: number }>`SELECT count(*)::int AS n FROM resume_versions`),
    one((q) => q<{ n: number }>`SELECT count(*)::int AS n FROM contacts`),
    one((q) => q<{ n: number }>`SELECT count(*)::int AS n FROM messages WHERE status = 'draft'`),
    // Existence only: the value column is never selected, so the resume text cannot reach this page.
    sql
      ? safe(async () => {
          const rows = await sql<{ stored: boolean }>`SELECT EXISTS (SELECT 1 FROM kv WHERE key = 'master_resume') AS stored`;
          return rows[0]?.stored === true;
        })
      : null,
    one((q) => q<{ n: number }>`SELECT count(*)::int AS n FROM preferences WHERE kind = 'rule' AND active`),
    sql
      ? safe(async () => {
          const rows = await sql<{ calls_today: number; usd_today: number; calls_total: number; usd_total: number }>`
            SELECT count(*) FILTER (WHERE (started_at AT TIME ZONE 'Asia/Singapore')::date = ${today}::date)::int AS calls_today,
                   COALESCE(sum((detail->>'costUsd')::numeric) FILTER (WHERE (started_at AT TIME ZONE 'Asia/Singapore')::date = ${today}::date), 0)::float8 AS usd_today,
                   count(*)::int AS calls_total,
                   COALESCE(sum((detail->>'costUsd')::numeric), 0)::float8 AS usd_total
            FROM runs WHERE step LIKE 'llm:%'`;
          const r = rows[0];
          return {
            callsToday: Number(r?.calls_today ?? 0),
            usdToday: Number(r?.usd_today ?? 0),
            callsTotal: Number(r?.calls_total ?? 0),
            usdTotal: Number(r?.usd_total ?? 0),
          };
        })
      : null,
  ]);
  return { openJobs, judgedJobs, appStates, resumeVersions, contacts, drafts, masterStored, rules, llm };
}

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const show = (n: number | null) => (n === null ? 'n/a' : n.toLocaleString('en-SG'));

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={s.stat}>
      <div className="muted small">{label}</div>
      <div className={s.num}>{value}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
    </div>
  );
}

function SliceCard({ slice, tag }: { slice: Slice; tag: string }) {
  return (
    <section className="card">
      <div className={s.head}>
        <h3>{slice.name}</h3>
        <span className="badge">{tag}</span>
      </div>
      <p className="muted small" style={{ margin: '4px 0 0' }}>
        {slice.purpose}
      </p>
      <div className={s.label}>Sees</div>
      <div className={s.chips}>
        {slice.sees.map((x) => (
          <span key={x} className="badge good">
            {x}
          </span>
        ))}
      </div>
      {slice.neverSees.length ? (
        <>
          <div className={s.label}>Never sees</div>
          <div className={s.chips}>
            {slice.neverSees.map((x) => (
              <span key={x} className={s.never}>
                {x}
              </span>
            ))}
          </div>
        </>
      ) : null}
      {slice.models.length ? (
        <>
          <div className={s.label}>Models</div>
          <div className="small">{slice.models.join(', ')}</div>
        </>
      ) : null}
      {slice.tools.length ? (
        <>
          <div className={s.label}>Tools</div>
          <div className="small">{slice.tools.join(', ')}</div>
        </>
      ) : null}
    </section>
  );
}

export default async function MemoryPage() {
  const today = sgtDate();
  const sql = await safe(() => getSql());
  const c = await loadCounts(sql, today);
  const demo = env.demoMode();
  const dailyCap = env.llmDailyUsdCap();
  const totalCap = env.llmTotalUsdCap();

  const router: Slice = {
    name: 'Router',
    purpose: 'Reads your message and picks one expert and one action. It answers with a choice, never with content.',
    sees: ['your current message', 'image and link flags', 'the last 4 turn summaries', 'the job you are on'],
    neverSees: ['your profile', 'your master resume', 'contacts', 'scores'],
    models: [`${env.modelFast()} (Nemotron 3 Nano)`],
    tools: [],
  };
  const daily: Slice = {
    name: 'Daily run',
    purpose: 'Every morning at 05:00 SGT it collects new postings from tracked boards, Nemotron Nano triages them, and Nemotron Ultra re-checks the top ones.',
    sees: ['tracked job boards', 'new postings', 'your profile', 'your preference rules'],
    neverSees: ['your master resume', 'contacts', 'drafts'],
    models: [`${env.modelFast()} (triage)`, `${env.modelReason()} (re-checks the top ones)`],
    tools: ['public job board APIs'],
  };
  const experts: { slice: Slice; tag: string }[] = [
    { slice: router, tag: 'routing' },
    { slice: sliceOf('Job Fetcher', jobFetcher, FALLBACK.job_fetcher), tag: 'expert' },
    { slice: sliceOf('Resume', resume, FALLBACK.resume), tag: 'expert' },
    { slice: sliceOf('Outreach', outreach, FALLBACK.outreach), tag: 'expert' },
    { slice: daily, tag: '05:00 SGT' },
  ];

  const master = c.masterStored === null ? 'n/a' : c.masterStored ? 'Stored' : 'Not stored';
  const states = c.appStates;

  return (
    <>
      <h1>Memory and control</h1>
      <p className={s.lead}>Everything lives in your own Postgres. Each expert gets only its own slice. Nothing leaves without your tap.</p>
      {sql === null ? <div className="notice">The database is not reachable right now, so the counts below show n/a.</div> : null}

      <h2>Who sees what</h2>
      <div className={s.grid}>
        {experts.map((e) => (
          <SliceCard key={e.slice.name} slice={e.slice} tag={e.tag} />
        ))}
      </div>

      <h2>What is stored</h2>
      <div className={s.stats}>
        <Stat label="Open jobs" value={show(c.openJobs)} />
        <Stat label="Judged jobs" value={show(c.judgedJobs)} />
        <Stat label="Resume versions" value={show(c.resumeVersions)} />
        <Stat label="Contacts" value={show(c.contacts)} />
        <Stat label="Drafts waiting" value={show(c.drafts)} hint="not sent" />
        <Stat label="Master resume" value={master} hint="text never shown here" />
        <Stat label="Active preference rules" value={show(c.rules)} />
        <Stat
          label="Model calls today"
          value={c.llm ? show(c.llm.callsToday) : 'n/a'}
          hint={c.llm ? `${usd(c.llm.usdToday)} of ${usd(dailyCap)} daily cap` : undefined}
        />
        <Stat
          label="Model calls total"
          value={c.llm ? show(c.llm.callsTotal) : 'n/a'}
          hint={c.llm ? `${usd(c.llm.usdTotal)} of ${usd(totalCap)} total cap` : undefined}
        />
      </div>

      <h3 style={{ fontSize: 15, margin: '18px 0 8px' }}>Applications by state</h3>
      {states === null ? (
        <p className="muted small">n/a</p>
      ) : states.length === 0 ? (
        <p className="muted small">No applications yet.</p>
      ) : (
        <div className={s.chips}>
          {states.map((r) => (
            <span key={r.state} className="badge">
              {r.state}: {r.n}
            </span>
          ))}
        </div>
      )}

      <h2>Your controls</h2>
      <ul className={s.controls}>
        <li>
          <span className="badge good">on</span>
          <span>Nothing is sent, submitted or posted without a tap from you.</span>
        </li>
        <li>
          <span className={demo ? 'badge warn' : 'badge good'}>{demo ? 'off in demo' : 'on'}</span>
          <span>Email only ever becomes a Gmail draft that you send yourself.{demo ? ' Saving Gmail drafts is turned off in this demo.' : ''}</span>
        </li>
        <li>
          <span className="badge good">on</span>
          <span>LinkedIn is never opened or fetched. Search always excludes linkedin.com.</span>
        </li>
        <li>
          <span className="badge good">on</span>
          <span>Text from job posts, web pages and screenshots is treated as data. Instructions inside it are ignored.</span>
        </li>
        <li>
          <span className="badge good">on</span>
          <span>
            Spend caps: {usd(dailyCap)} per day and {usd(totalCap)} in total. At a cap the app stops calling models and shows a banner.
          </span>
        </li>
      </ul>
    </>
  );
}
