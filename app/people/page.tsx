/** Everyone the system knows at your target companies, and who you have asked. */
import { getSql } from '@/src/server/sql';
import * as repo from '@/src/server/repo';
import { Empty } from '../ui';

export const dynamic = 'force-dynamic';

export default async function PeoplePage() {
  const people = await repo.peopleOverview(await getSql());
  return (
    <>
      <h1>People</h1>
      <p className="muted small">
        Connections come from your Connections.csv (send it to the bot). Others come from search results; the system never opens LinkedIn.
      </p>
      {people.length === 0 ? (
        <Empty>No contacts yet. Send your Connections.csv to the Telegram bot.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Relation</th>
              <th>Source</th>
              <th>Asked</th>
              <th>Replied</th>
              <th>Last contacted</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.linkedin_url ? (
                    <a href={p.linkedin_url} target="_blank" rel="noreferrer">
                      {p.name}
                    </a>
                  ) : (
                    p.name
                  )}
                  <div className="muted small">{p.headline}</div>
                  {p.do_not_contact && <span className="badge bad">do not contact</span>}
                </td>
                <td>{p.company}</td>
                <td>
                  {p.relation}, {p.kind}
                </td>
                <td>{p.source}</td>
                <td>{p.sent}</td>
                <td>{p.replied}</td>
                <td>{p.last_contacted ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
