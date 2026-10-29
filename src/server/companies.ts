/**
 * Companies view queries. A job counts while it is open, or once you have an application for it (so applied jobs
 * stay visible after the posting closes). Job type follows core/filters.jobTypeOf.
 */
import type { Sql } from './sql';
import type { CompanyQuery, ViewType } from '../core/companies';

const USER = 1;

export interface CompanyRow {
  id: number;
  name: string;
  tier: string | null;
  jobs: number;
  intern: number;
  parttime: number;
  fulltime: number;
  v_now: number;
  v_week: number;
  v_watch: number;
  v_skip: number;
  v_none: number;
  best: number | null;
  applied: number;
  active: number;
  deciding: number;
  last_seen: string;
  total: number;
}

export async function companyOverview(sql: Sql, q: CompanyQuery): Promise<{ rows: CompanyRow[]; total: number }> {
  const rows = await sql<CompanyRow>`
    WITH j AS (
      SELECT j.company_id, j.last_seen,
             CASE WHEN j.track = 'ft' THEN 'fulltime' WHEN j.hours_flag LIKE '%part-time%' THEN 'parttime' ELSE 'intern' END AS jtype,
             lj.score, lj.verdict, a.state
      FROM jobs j
      LEFT JOIN latest_judgments lj ON lj.job_id = j.id
      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
      WHERE j.company_id IS NOT NULL AND (j.closed_at IS NULL OR a.id IS NOT NULL)
    ), c AS (
      SELECT co.id, co.name, co.tier,
             count(*)::int AS jobs,
             count(*) FILTER (WHERE jtype = 'intern')::int AS intern,
             count(*) FILTER (WHERE jtype = 'parttime')::int AS parttime,
             count(*) FILTER (WHERE jtype = 'fulltime')::int AS fulltime,
             count(*) FILTER (WHERE verdict = 'Apply now')::int AS v_now,
             count(*) FILTER (WHERE verdict = 'Apply this week')::int AS v_week,
             count(*) FILTER (WHERE verdict = 'Watch')::int AS v_watch,
             count(*) FILTER (WHERE verdict = 'Skip')::int AS v_skip,
             count(*) FILTER (WHERE verdict IS NULL)::int AS v_none,
             max(score)::int AS best,
             count(*) FILTER (WHERE state IN ('applied', 'interview', 'offer'))::int AS applied,
             count(*) FILTER (WHERE state IN ('tailoring', 'finding_contact', 'awaiting_send', 'ask_sent', 'ready_to_fill', 'prefilled'))::int AS active,
             count(*) FILTER (WHERE state IN ('today', 'snoozed'))::int AS deciding,
             max(last_seen)::text AS last_seen
      FROM j JOIN companies co ON co.id = j.company_id
      WHERE (${q.type}::text = '' OR jtype = ${q.type}::text)
      GROUP BY co.id, co.name, co.tier
    )
    SELECT *, count(*) OVER ()::int AS total FROM c
    WHERE (${q.q}::text = '' OR name ILIKE '%' || ${q.q}::text || '%')
    ORDER BY
      CASE WHEN ${q.sort}::text = 'name' THEN lower(name) END ASC,
      CASE WHEN ${q.sort}::text = 'jobs' THEN jobs END DESC,
      CASE WHEN ${q.sort}::text = 'recent' THEN last_seen END DESC,
      best DESC NULLS LAST, jobs DESC, lower(name) ASC
    LIMIT ${q.limit}::int OFFSET ${q.offset}::int`;
  return { rows, total: rows[0]?.total ?? 0 };
}

export interface CompanyJobRow {
  id: number;
  title: string;
  location: string;
  jtype: string;
  score: number | null;
  verdict: string | null;
  deadline: string | null;
  app_id: number | null;
  state: string | null;
  applied_at: string | null;
  posted: string | null;
  first_seen: string;
  closed_at: string | null;
  url: string;
  apply_route: string | null;
  total: number;
}

export async function companyJobs(sql: Sql, companyId: number, type: ViewType, offset: number, limit: number): Promise<{ rows: CompanyJobRow[]; total: number }> {
  const rows = await sql<CompanyJobRow>`
    SELECT * , count(*) OVER ()::int AS total FROM (
      SELECT j.id, j.title, j.location,
             CASE WHEN j.track = 'ft' THEN 'fulltime' WHEN j.hours_flag LIKE '%part-time%' THEN 'parttime' ELSE 'intern' END AS jtype,
             lj.score, lj.verdict, NULLIF(lj.deadline, '') AS deadline,
             a.id AS app_id, a.state, a.applied_at::text AS applied_at,
             j.posted::text AS posted, j.first_seen::text AS first_seen, j.closed_at::text AS closed_at,
             COALESCE(j.apply_url, j.url) AS url, j.apply_route
      FROM jobs j
      LEFT JOIN latest_judgments lj ON lj.job_id = j.id
      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
      WHERE j.company_id = ${companyId}::int AND (j.closed_at IS NULL OR a.id IS NOT NULL)
    ) x
    WHERE (${type}::text = '' OR jtype = ${type}::text)
    ORDER BY (state IS NOT NULL AND state NOT IN ('skipped', 'withdrawn', 'rejected')) DESC, score DESC NULLS LAST, first_seen DESC, id DESC
    LIMIT ${limit}::int OFFSET ${offset}::int`;
  return { rows, total: rows[0]?.total ?? 0 };
}

export interface CompanyTotals {
  companies: number;
  jobs: number;
  scored: number;
  strong: number;
  applied: number;
  intern: number;
  parttime: number;
  fulltime: number;
}

/** Headline numbers for the top of the page (all open jobs, no filters). */
export async function companyTotals(sql: Sql): Promise<CompanyTotals> {
  const r = await sql<CompanyTotals>`
    WITH j AS (
      SELECT j.company_id, CASE WHEN j.track = 'ft' THEN 'fulltime' WHEN j.hours_flag LIKE '%part-time%' THEN 'parttime' ELSE 'intern' END AS jtype,
             lj.verdict, a.state
      FROM jobs j
      LEFT JOIN latest_judgments lj ON lj.job_id = j.id
      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${USER}
      WHERE j.company_id IS NOT NULL AND (j.closed_at IS NULL OR a.id IS NOT NULL)
    )
    SELECT count(DISTINCT company_id)::int AS companies, count(*)::int AS jobs,
           count(*) FILTER (WHERE verdict IS NOT NULL)::int AS scored,
           count(*) FILTER (WHERE verdict IN ('Apply now', 'Apply this week'))::int AS strong,
           count(*) FILTER (WHERE state IN ('applied', 'interview', 'offer'))::int AS applied,
           count(*) FILTER (WHERE jtype = 'intern')::int AS intern,
           count(*) FILTER (WHERE jtype = 'parttime')::int AS parttime,
           count(*) FILTER (WHERE jtype = 'fulltime')::int AS fulltime
    FROM j`;
  return r[0];
}
