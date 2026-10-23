/** Small shared pieces for the server-rendered pages. */
import type { ReactNode } from 'react';

export function ActionButton({ action, id, label, back, primary }: { action: string; id: number; label: string; back: string; primary?: boolean }) {
  return (
    <form className="inline" action="/api/actions" method="post">
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="back" value={back} />
      <button type="submit" className={primary ? 'primary' : undefined}>
        {label}
      </button>
    </form>
  );
}

export function Verdict({ verdict, score }: { verdict?: string | null; score?: number | null }) {
  if (!verdict) return <span className="badge">not judged</span>;
  const cls = verdict === 'Apply now' ? 'good' : verdict === 'Apply this week' ? '' : verdict === 'Watch' ? 'warn' : 'bad';
  return <span className={`badge ${cls}`}>{score ?? '-'} {verdict}</span>;
}

export function Notice({ msg }: { msg?: string }) {
  return msg ? <div className="notice">{msg}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}
