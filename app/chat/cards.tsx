'use client';
/**
 * How the assistant's answers look: the step trace and the four card kinds. Everything here only renders what the
 * server sent. Text that came from job posts or web pages is shown as plain text (React escapes it) and links are
 * kept to http(s), so a posting cannot inject markup or a javascript: link.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ActionRequest, Card, ExpertId, GateCheck, StepEvent } from '@/src/agents/types';

export type OnAction = (label: string, request: ActionRequest) => void;

// ---------- small helpers ----------

export function safeHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, 'https://x.invalid');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.host === 'x.invalid' ? url : u.href; // keep same-origin paths such as /api/resume/12 relative
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function fmtUsd(v: number | undefined, digits = 4): string {
  if (v === undefined || !Number.isFinite(v)) return '';
  return `$${v.toFixed(digits)}`;
}

function fmtTok(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '0';
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" -> "Nemotron 3 Nano". Unknown IDs fall back to their last path segment. */
export function modelShortName(model: string | undefined): string {
  if (!model) return '';
  const m = /nemotron[-_ ]?(\d+(?:[._]\d+)?)?[-_ ]?(nano|ultra|super[-_ ]?vl|super|lightning)/i.exec(model);
  if (m) {
    const version = m[1] ? `${m[1].replace('_', '.')} ` : '';
    const size = m[2].toLowerCase().replace(/[-_ ]/g, '');
    const name = size === 'supervl' ? 'Super VL' : size[0].toUpperCase() + size.slice(1);
    return `Nemotron ${version}${name}`;
  }
  return model.split('/').pop() ?? model;
}

/** The one-word tier for a chip: Nano, Ultra, Super VL or Lightning. */
export function modelTier(model: string | undefined): string {
  const n = modelShortName(model);
  return n.replace(/^Nemotron\s+(\d+(?:\.\d+)?\s+)?/, '') || n;
}

export function ModelChip({ model }: { model?: string }) {
  if (!model) return null;
  return (
    <span className="ch-model" title={model}>
      {modelTier(model)}
    </span>
  );
}

const EXPERT_LABEL: Record<string, string> = {
  job_fetcher: 'Job Fetcher',
  resume: 'Resume',
  outreach: 'Outreach',
  router: 'Router',
  intake: 'Intake',
  daily: 'Daily run',
};
export const expertLabel = (e: ExpertId | string) => EXPERT_LABEL[e] ?? e;

export function verdictTone(verdict: string | null | undefined): 'now' | 'week' | 'watch' | 'skip' | 'none' {
  const v = (verdict ?? '').toLowerCase();
  if (v.startsWith('apply now')) return 'now';
  if (v.startsWith('apply')) return 'week';
  if (v.startsWith('watch')) return 'watch';
  if (v.startsWith('skip')) return 'skip';
  return 'none';
}

function Icon({ kind }: { kind: 'pass' | 'fail' | 'flag' }) {
  if (kind === 'pass')
    return (
      <svg className="ch-ico pass" viewBox="0 0 16 16" aria-label="pass">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (kind === 'fail')
    return (
      <svg className="ch-ico fail" viewBox="0 0 16 16" aria-label="fail">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg className="ch-ico flag" viewBox="0 0 16 16" aria-label="flag">
      <path d="M8 3.5v5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="8" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('fail');
    }
    setTimeout(() => setState('idle'), 1600);
  }
  return (
    <button type="button" className="ch-btn small" onClick={copy}>
      {state === 'done' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

// ---------- step trace ----------

const STATUS_TEXT: Record<StepEvent['status'], string> = { ok: 'ok', fallback: 'fallback', error: 'error', skipped: 'skipped' };

export function Trace({
  steps,
  route,
  pending,
  totalCostUsd,
  latest = false,
}: {
  steps: StepEvent[];
  route?: { expert: ExpertId; action: string; confidence: number }[];
  pending: boolean;
  totalCostUsd?: number;
  latest?: boolean;
}) {
  // Open while the answer streams, folds itself away when it is done; a click toggles it either way.
  const [open, setOpen] = useState(pending);
  useEffect(() => setOpen(pending), [pending]);
  if (!pending && steps.length === 0 && !route?.length) return null;
  const ms = steps.reduce((s, x) => s + (x.ms ?? 0), 0);
  const cost = totalCostUsd ?? steps.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  const secs = ms >= 1000 ? `${Math.round(ms / 1000)} s` : fmtMs(ms) || '0 s';
  const parts = [`${steps.length} step${steps.length === 1 ? '' : 's'}`];
  if (cost > 0) parts.push(fmtUsd(cost));
  return (
    <div className={`ch-trace${open ? ' open' : ''}`} data-tour={latest ? 'trace' : undefined}>
      <button type="button" className="ch-trace-sumrow" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {pending ? <span className="ch-spin" aria-hidden /> : <span className="ch-trace-ok" aria-hidden />}
        <span className="ch-trace-title">{pending ? 'Working' : `Worked for ${secs}`}</span>
        <span className="ch-trace-sum">· {parts.join(' · ')}</span>
        <svg className="ch-chev" viewBox="0 0 16 16" aria-hidden>
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ch-trace-body">
          {route && route.length > 0 && (
            <div className="ch-route">
              Routed to <b>{expertLabel(route[0].expert)}</b>, {route[0].action.replace(/_/g, ' ')} ({Math.round(route[0].confidence * 100)}%)
              {route.length > 1 && <span className="muted"> · next: {route.slice(1).map((r) => r.action.replace(/_/g, ' ')).join(', ')}</span>}
            </div>
          )}
          <ol className="ch-steps">
            {steps.map((s, i) => (
              <li key={i} className={`ch-step s-${s.status}`}>
                <span className="ch-dot" title={STATUS_TEXT[s.status]} />
                <span className="ch-step-label">
                  <span className="ch-step-exp">{expertLabel(s.expert)}</span>
                  {s.label}
                </span>
                <span className="ch-step-meta">
                  {s.status === 'fallback' && <span className="pill warn">fallback</span>}
                  {s.status === 'error' && <span className="pill bad">error</span>}
                  {s.status === 'skipped' && <span className="pill">skipped</span>}
                  <ModelChip model={s.model} />
                  {s.ms !== undefined && <span className="ch-num">{fmtMs(s.ms)}</span>}
                  {(s.tokensIn !== undefined || s.tokensOut !== undefined) && (
                    <span className="ch-num ch-tok" title={`${s.tokensIn ?? 0} tokens in, ${s.tokensOut ?? 0} tokens out`}>
                      {fmtTok(s.tokensIn)} / {fmtTok(s.tokensOut)} tok
                    </span>
                  )}
                  {s.costUsd !== undefined && <span className="ch-num">{fmtUsd(s.costUsd)}</span>}
                </span>
              </li>
            ))}
            {pending && (
              <li className="ch-step s-pending">
                <span className="ch-dot" />
                <span className="ch-step-label muted">{steps.length ? 'Next step running' : 'Reading your message'}</span>
              </li>
            )}
          </ol>
        </div>
      )}
    </div>
  );
}

// ---------- cards ----------

function ScoreRing({ score, verdict }: { score: number | null; verdict: string }) {
  const r = 21;
  const c = 2 * Math.PI * r;
  const v = score === null || !Number.isFinite(score) ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className={`ch-ring v-${verdictTone(verdict)}`} role="img" aria-label={`score ${score ?? 'none'} of 100`}>
      <svg viewBox="0 0 52 52">
        <circle cx="26" cy="26" r={r} className="track" />
        <circle cx="26" cy="26" r={r} className="arc" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 26 26)" />
      </svg>
      <span>{score ?? '-'}</span>
    </div>
  );
}

function gateStatus(value: string): 'pass' | 'flag' | 'fail' | 'other' {
  const w = value.trim().split(/[\s:,.-]/)[0].toUpperCase();
  return w === 'PASS' ? 'pass' : w === 'FLAG' ? 'flag' : w === 'FAIL' ? 'fail' : 'other';
}

function JobCard({ card }: { card: Extract<Card, { kind: 'job' }> }) {
  const href = safeHref(card.url);
  const gates = Object.entries(card.gates ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rolling = !card.deadline || card.deadline === 'rolling';
  return (
    <article className="ch-card">
      <div className="ch-job-head">
        <ScoreRing score={card.score} verdict={card.verdict} />
        <div className="ch-job-title">
          <div className="ch-kicker">{card.company}</div>
          <h4>{card.title}</h4>
          <div className="ch-tags">
            <span className={`pill v-${verdictTone(card.verdict)}`}>{card.verdict || 'Not judged'}</span>
            <span className={`pill${rolling ? '' : ' warn'}`}>{rolling ? 'Rolling deadline' : `Closes ${card.deadline}`}</span>
            <ModelChip model={card.model} />
          </div>
        </div>
      </div>
      {gates.length > 0 && (
        <div className="ch-gates" aria-label="Scoring gates">
          {gates.map(([id, value]) => {
            const st = gateStatus(value);
            return (
              <span key={id} className={`ch-gate g-${st}`} title={value}>
                <b>{id}</b> {st === 'other' ? value.slice(0, 12) : st.toUpperCase()}
              </span>
            );
          })}
        </div>
      )}
      {card.notes && <p className="ch-notes">{card.notes}</p>}
      {card.flags.length > 0 && (
        <ul className="ch-flags">
          {card.flags.map((f, i) => (
            <li key={i}>
              <Icon kind="flag" /> {f}
            </li>
          ))}
        </ul>
      )}
      {href && (
        <div className="ch-card-foot">
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open posting on {hostOf(href)}
          </a>
        </div>
      )}
    </article>
  );
}

function JobsCard({ card, onAction, busy }: { card: Extract<Card, { kind: 'jobs' }>; onAction: OnAction; busy: boolean }) {
  return (
    <article className="ch-card">
      <h4 className="ch-card-h">{card.heading}</h4>
      {card.checked.length > 0 && <p className="ch-checked">Checked: {card.checked.join(', ')}</p>}
      {card.items.length === 0 && <p className="muted small">Nothing matched.</p>}
      <ul className="ch-rows">
        {card.items.map((it, i) => {
          const href = safeHref(it.url);
          const both = typeof it.nanoScore === 'number' && typeof it.ultraScore === 'number';
          return (
            <li key={`${it.jobId}-${i}`} className="ch-rowi">
              <span className={`ch-score v-${verdictTone(it.verdict)}`} title={it.verdict || 'not judged'}>
                {it.score ?? '-'}
              </span>
              <div className="ch-rowi-main">
                <div className="ch-rowi-title">
                  <b>{it.company}</b>{' '}
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {it.title}
                    </a>
                  ) : (
                    it.title
                  )}
                </div>
                <div className="ch-rowi-sub">
                  {it.verdict && <span className={`pill v-${verdictTone(it.verdict)}`}>{it.verdict}</span>}
                  {both && (
                    <span className="ch-cascade" title="Nano triage score, then Ultra re-judge">
                      Nano {it.nanoScore} <span aria-hidden>→</span> Ultra {it.ultraScore}
                    </span>
                  )}
                  {it.notes && <span className="ch-rowi-notes">{it.notes}</span>}
                </div>
              </div>
              {it.appId !== undefined && (
                <div className="ch-rowi-act">
                  <button
                    type="button"
                    className="ch-btn small"
                    disabled={busy}
                    onClick={() => onAction(`Tailor resume for ${it.company}`, { expert: 'resume', action: 'tailor', args: { appId: it.appId, company: it.company } })}
                  >
                    Tailor
                  </button>
                  <button
                    type="button"
                    className="ch-btn small"
                    disabled={busy}
                    onClick={() =>
                      onAction(`Find someone at ${it.company}`, { expert: 'outreach', action: 'find_contact_and_draft', args: { appId: it.appId, company: it.company } })
                    }
                  >
                    Find someone
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function CheckList({ checks }: { checks: GateCheck[] }) {
  if (!checks.length) return null;
  return (
    <ul className="ch-checks">
      {checks.map((c, i) => (
        <li key={`${c.id}-${i}`} className={c.pass ? 'ok' : 'no'}>
          <Icon kind={c.pass ? 'pass' : 'fail'} />
          <span>
            <b>{c.id.replace(/_/g, ' ')}</b>
            {c.detail && <span className="muted"> {c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ResumeCard({ card }: { card: Extract<Card, { kind: 'resume' }> }) {
  const href = safeHref(card.downloadUrl);
  const pct = Math.max(0, Math.min(100, Math.round(card.matchPct)));
  const passed = card.checks.filter((c) => c.pass).length;
  return (
    <article className="ch-card">
      <div className="ch-card-top">
        <h4 className="ch-card-h">Tailored resume</h4>
        <div className="ch-tags">
          <span className={`pill ${card.pass ? 'good' : 'bad'}`}>{card.pass ? 'All checks passed' : 'Some checks failed'}</span>
          {card.revised && <span className="pill accent">Revised once</span>}
          <ModelChip model={card.model} />
        </div>
      </div>
      <div className="ch-match">
        <span className="ch-match-n">{pct}%</span>
        <div className="ch-match-body">
          <span className="small muted">Match with the job description</span>
          <div className="ch-meter">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      {card.checks.length > 0 && (
        <>
          <div className="ch-sub">
            Checked in code against your master resume <span className="muted">({passed} of {card.checks.length} passed)</span>
          </div>
          <CheckList checks={card.checks} />
        </>
      )}
      {card.changes.length > 0 && (
        <>
          <div className="ch-sub">What changed</div>
          <ul className="ch-list">
            {card.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {card.gaps.length > 0 && (
        <>
          <div className="ch-sub">Gaps the job asks for</div>
          <ul className="ch-list">
            {card.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </>
      )}
      <div className="ch-card-foot">
        {href && (
          <a className="ch-btn primary" href={href} target="_blank" rel="noopener noreferrer">
            Open PDF
          </a>
        )}
        {card.dropped > 0 && (
          <span className="small muted">
            {card.dropped} line{card.dropped === 1 ? '' : 's'} trimmed to fit one page
          </span>
        )}
      </div>
    </article>
  );
}

function DraftCard({ card }: { card: Extract<Card, { kind: 'draft' }> }) {
  const src = safeHref(card.contact?.sourceUrl);
  const search = safeHref(card.linkedinSearchUrl);
  const noteLen = [...card.linkedinNote].length;
  const emailText = card.subject ? `Subject: ${card.subject}\n\n${card.emailBody}` : card.emailBody;
  return (
    <article className="ch-card">
      <div className="ch-card-top">
        <h4 className="ch-card-h">Referral ask</h4>
        <div className="ch-tags">
          <span className="pill">Draft only, nothing sent</span>
        </div>
      </div>
      {card.contact ? (
        <div className="ch-contact">
          <div className="ch-contact-name">
            <b>{card.contact.name}</b>
            {card.contact.headline && <span className="muted"> · {card.contact.headline}</span>}
          </div>
          {card.contact.evidence && <blockquote className="ch-quote">{card.contact.evidence}</blockquote>}
          {src && (
            <div className="small">
              Quote verified on{' '}
              <a href={src} target="_blank" rel="noopener noreferrer">
                {hostOf(src)}
              </a>
            </div>
          )}
        </div>
      ) : (
        <p className="ch-notes">I could not verify a public contact for this company, so the draft has no name. Use the LinkedIn search below and pick someone yourself.</p>
      )}
      {card.checks.length > 0 && (
        <div className="ch-gates">
          {card.checks.map((c, i) => (
            <span key={`${c.id}-${i}`} className={`ch-gate g-${c.pass ? 'pass' : 'fail'}`} title={c.detail}>
              {c.pass ? <Icon kind="pass" /> : <Icon kind="fail" />} {c.id.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}
      {card.emailBody && (
        <section className="ch-draft">
          <div className="ch-draft-head">
            <span className="ch-sub">Email</span>
            <CopyButton text={emailText} label="Copy email" />
          </div>
          {card.subject && (
            <div className="ch-subject">
              <span className="muted">Subject</span> {card.subject}
            </div>
          )}
          <div className="ch-body">{card.emailBody}</div>
        </section>
      )}
      {card.linkedinNote && (
        <section className="ch-draft">
          <div className="ch-draft-head">
            <span className="ch-sub">
              LinkedIn note <span className={`ch-count${noteLen > 200 ? ' over' : ''}`}>{noteLen}/200</span>
            </span>
            <CopyButton text={card.linkedinNote} label="Copy note" />
          </div>
          <div className="ch-body">{card.linkedinNote}</div>
        </section>
      )}
      <div className="ch-card-foot">
        {search && (
          <a className="ch-btn" href={search} target="_blank" rel="noopener noreferrer">
            Open LinkedIn search
          </a>
        )}
        {card.demo || card.messageId === null ? (
          <span className="ch-disabled">
            <button type="button" className="ch-btn" disabled>
              Save to Gmail drafts
            </button>
            <span className="small muted">
              {card.demo ? 'Off in the public demo. In the real app this saves a Gmail draft after your tap; nothing is ever sent for you.' : 'Nothing to save yet.'}
            </span>
          </span>
        ) : (
          <form action="/api/actions" method="post" className="inline">
            <input type="hidden" name="action" value="send" />
            <input type="hidden" name="id" value={card.appId} />
            <input type="hidden" name="back" value="/chat" />
            <button type="submit" className="ch-btn primary">
              Save to Gmail drafts
            </button>
          </form>
        )}
      </div>
    </article>
  );
}

export function CardView({ card, onAction, busy }: { card: Card; onAction: OnAction; busy: boolean }): ReactNode {
  switch (card.kind) {
    case 'job':
      return <JobCard card={card} />;
    case 'jobs':
      return <JobsCard card={card} onAction={onAction} busy={busy} />;
    case 'resume':
      return <ResumeCard card={card} />;
    case 'draft':
      return <DraftCard card={card} />;
    default:
      return null;
  }
}
