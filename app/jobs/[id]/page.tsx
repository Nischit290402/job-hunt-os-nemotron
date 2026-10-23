/** One job: description, score, your application, contacts, messages, resume and timeline. */
import { notFound } from 'next/navigation';
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { ActionButton, Empty, Notice, Verdict } from '../../ui';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const id = Number((await params).id);
  const { msg } = await searchParams;
  if (!Number.isInteger(id)) notFound();
  const sql = await getSql();
  const job = await repo.getJob(sql, id);
  if (!job) notFound();
  const app = await repo.appForJob(sql, id);
  const back = `/jobs/${id}`;
  const companyRow = await sql`SELECT id FROM companies WHERE key = ${job.company_key}`;
  const contacts = companyRow.length ? await repo.contactsAtCompany(sql, companyRow[0].id) : [];
  const messages = app ? await repo.messagesForApp(sql, app.id) : [];
  const draft = app ? await repo.latestDraft(sql, app.id) : null;
  const resume = app ? await repo.latestResume(sql, app.id) : null;
  const events = app ? await repo.eventsFor(sql, 'application', app.id) : [];
  const gates = (job.gates ?? {}) as Record<string, string>;

  return (
    <>
      <h1>
        {job.company}, {job.title}
      </h1>
      <Notice msg={msg} />
      <div className="row small">
        <Verdict verdict={job.verdict} score={job.score} />
        <span className="badge">{job.track}</span>
        <span className="badge">{job.family}</span>
        {job.start_window && <span className="badge">{job.start_window}</span>}
        {job.deadline && <span className="badge warn">deadline {job.deadline}</span>}
        {job.closed_at && <span className="badge bad">closed {job.closed_at}</span>}
        <a href={job.url} target="_blank" rel="noreferrer">
          Open posting
        </a>
      </div>

      <div className="grid2">
        <section>
          <h2>Judge notes</h2>
          <p>{job.notes || <span className="muted">Not judged yet.</span>}</p>
          {job.flags?.length > 0 && <p className="small muted">Flags: {job.flags.join('; ')}</p>}
          {Object.keys(gates).length > 0 && (
            <p className="small muted">
              Gates: {Object.entries(gates).map(([g, v]) => `${g} ${v}`).join(', ')}
            </p>
          )}
          <h2>Job description</h2>
          {job.jd_text ? <pre className="jd">{job.jd_text}</pre> : <Empty>No description stored ({job.jd_status}). Open the posting.</Empty>}
        </section>

        <aside>
          <h2>Your application</h2>
          {!app && <Empty>Not in your pipeline. It appears in Today when it ranks in the top 3.</Empty>}
          {app && (
            <div className="card">
              <p>
                State: <b>{app.state.replace(/_/g, ' ')}</b>
                {app.applied_at ? `, applied ${app.applied_at}` : ''}
              </p>
              {app.skip_reason && <p className="muted small">Skip reason: {app.skip_reason}</p>}
              <div className="row">
                {['today', 'snoozed'].includes(app.state) && <ActionButton action="apply" id={app.id} label="Apply" back={back} primary />}
                {['tailoring', 'finding_contact', 'awaiting_send', 'ask_sent', 'ready_to_fill', 'prefilled'].includes(app.state) && (
                  <ActionButton action="submitted" id={app.id} label="I submitted it" back={back} />
                )}
              </div>
              {resume && (
                <p className="small">
                  <a href={`/api/resume/${app.id}`} target="_blank" rel="noreferrer">
                    Tailored resume
                  </a>{' '}
                  · {resume.verify_passed === false ? 'verify.py failed' : resume.verify_passed ? 'verify.py passed' : 'not verified'} · {resume.summary}
                </p>
              )}
            </div>
          )}

          {draft && app && (
            <>
              <h2>Draft to {draft.contact_name}</h2>
              <form action="/api/draft" method="post">
                <input type="hidden" name="appId" value={app.id} />
                <input type="hidden" name="back" value={back} />
                <p className="small"><b>{draft.subject}</b></p>
                <textarea name="body" defaultValue={draft.body} />
                <div className="row">
                  <button type="submit">Save edit</button>
                </div>
              </form>
              <div className="row" style={{ marginTop: 8 }}>
                <ActionButton action="send" id={app.id} label={draft.channel === 'email' ? 'Send email' : 'I sent it on LinkedIn'} back={back} primary />
                <ActionButton action="drop" id={app.id} label="Drop" back={back} />
              </div>
              {draft.linkedin_note && <p className="small">LinkedIn note: <code>{draft.linkedin_note}</code></p>}
            </>
          )}

          <h2>People at {job.company}</h2>
          {contacts.length === 0 && <Empty>No contacts yet.</Empty>}
          {contacts.slice(0, 8).map((c) => (
            <div className="small" key={c.id} style={{ marginBottom: 6 }}>
              {c.linkedin_url ? (
                <a href={c.linkedin_url} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
              ) : (
                c.name
              )}{' '}
              <span className="muted">
                · {c.headline} · {c.relation} · {c.email ? 'email' : 'no email'}
              </span>
            </div>
          ))}

          {messages.length > 0 && (
            <>
              <h2>Messages</h2>
              {messages.map((m) => (
                <div className="small" key={m.id}>
                  {m.kind} to {m.contact_name}: {m.status} {m.sent_at ? `on ${m.sent_at.slice(0, 10)}` : ''}
                </div>
              ))}
            </>
          )}

          {events.length > 0 && (
            <>
              <h2>Timeline</h2>
              {events.map((e, i) => (
                <div className="small muted" key={i}>
                  {e.at.slice(0, 16)} · {e.action} ({e.actor})
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
