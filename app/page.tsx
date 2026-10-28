/** Today: the same items as the morning brief, for when you are at a desk. */
import { getSql } from '@/src/server/sql';
import { briefData } from '@/src/server/steps';
import { healthLine } from '@/src/core/brief';
import { sgtDate } from '@/src/core/time';
import { ActionButton, Empty, Notice, Verdict } from './ui';

export const dynamic = 'force-dynamic';

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const today = sgtDate();
  const d = await briefData(await getSql(), today);
  return (
    <>
      <h1>Today, {today}</h1>
      <Notice msg={msg} />
      <p className="muted">
        This week: {d.week.applied} applied, {d.week.referralsSent} referral asks, target {d.week.target}. {healthLine(d.health)}
        {d.paused ? ' Outward actions are paused.' : ''}
      </p>

      <h2>Decide ({d.today.length})</h2>
      {d.today.length === 0 && <Empty>Nothing waiting for a decision.</Empty>}
      {d.today.map((t) => (
        <div className="card" key={t.applicationId}>
          <h3>
            <a href={`/jobs/${t.jobId}`}>{t.company}, {t.title}</a>
          </h3>
          <div className="row small">
            <Verdict verdict={t.verdict} score={t.score} />
            <span className="badge">{t.family}</span>
            {t.deadline && t.deadline !== 'rolling' && <span className="badge warn">closes {t.deadline}</span>}
            {t.daysWaiting >= 2 && <span className="badge warn">waiting {t.daysWaiting} days</span>}
          </div>
          <p>{t.notes}</p>
          {t.flags.length > 0 && <p className="small muted">Flags: {t.flags.join('; ')}</p>}
          <div className="row">
            <ActionButton action="apply" id={t.applicationId} label="Apply" back="/" primary />
            <ActionButton action="skip:scope" id={t.applicationId} label="Skip: scope" back="/" />
            <ActionButton action="skip:company" id={t.applicationId} label="Skip: company" back="/" />
            <ActionButton action="skip:other" id={t.applicationId} label="Skip: other" back="/" />
            <ActionButton action="snooze" id={t.applicationId} label="Snooze 3 days" back="/" />
          </div>
        </div>
      ))}

      <h2>Approve ({d.approvals.length})</h2>
      {d.approvals.length === 0 && <Empty>No drafts waiting.</Empty>}
      {d.approvals.map((a) => (
        <div className="card" key={`a${a.applicationId}`}>
          <h3>
            Referral ask to {a.contactName}, {a.company}
          </h3>
          <p className="small muted">{a.contactHeadline} · {a.email ?? 'LinkedIn note only'}</p>
          {a.email && (
            <>
              <p><b>{a.subject}</b></p>
              <pre className="jd">{a.body}</pre>
            </>
          )}
          {a.linkedinUrl && (
            <p className="small">
              LinkedIn note: <code>{a.linkedinNote}</code> · <a href={a.linkedinUrl} target="_blank" rel="noreferrer">profile</a>
            </p>
          )}
          <div className="row">
            <ActionButton action="send" id={a.applicationId} label={a.email ? 'Save to Gmail drafts' : 'I sent it on LinkedIn'} back="/" primary />
            <ActionButton action="drop" id={a.applicationId} label="Drop" back="/" />
            {a.jobId && <a className="btn" href={`/jobs/${a.jobId}`}>Edit on job page</a>}
          </div>
        </div>
      ))}

      <h2>Submit ({d.ready.length})</h2>
      {d.ready.length === 0 && <Empty>No applications waiting for you.</Empty>}
      {d.ready.map((r) => (
        <div className="card" key={`r${r.applicationId}`}>
          <h3>{r.company}, {r.title}</h3>
          <p className="small muted">{r.state === 'prefilled' ? 'Form filled on your laptop. Review and click Submit there.' : 'Waiting for the laptop agent, or apply by hand.'}</p>
          <div className="row">
            <a className="btn" href={r.applyUrl} target="_blank" rel="noreferrer">Open apply page</a>
            <ActionButton action="submitted" id={r.applicationId} label="I submitted it" back="/" primary />
          </div>
        </div>
      ))}
    </>
  );
}
