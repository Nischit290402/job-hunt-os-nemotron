/** Every company with open jobs: counts by type, how well they fit, and where you stand. Jobs load on demand. */
import { getSql } from '@/src/server/sql';
import { companyOverview, companyTotals } from '@/src/server/companies';
import { parseCompanyQuery } from '@/src/core/companies';
import Explorer from './explorer';

export const dynamic = 'force-dynamic';

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = String((await searchParams).q ?? '').slice(0, 60);
  const sql = await getSql();
  const [first, totals] = await Promise.all([companyOverview(sql, parseCompanyQuery(new URLSearchParams(q ? { q } : {}))), companyTotals(sql)]);
  return (
    <>
      <h1>Companies</h1>
      <Explorer initial={first} totals={totals} initialQuery={q} />
    </>
  );
}
