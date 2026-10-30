'use client';
/**
 * The web chat. Posts a ChatRequest to /api/chat and renders the NDJSON StreamEvents as they arrive.
 * The server keeps no chat history in this release, so the client sends the last 4 turn summaries and the job the
 * conversation is about (lastAppId); the server checks that id before using it.
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { ActionRequest, Card, ChatRequest, ExpertId, ImageIn, StepEvent, StreamEvent, SuggestedAction, TurnSummary } from '@/src/agents/types';
import { CardView, Trace, fmtUsd, safeHref } from './cards';

type Attachment = ImageIn & { id: string; preview: string };
type Block =
  | { kind: 'card'; card: Card }
  | { kind: 'text'; text: string }
  | { kind: 'banner'; level: 'info' | 'warn' | 'error'; text: string; link?: string };

interface Turn {
  id: number;
  user: { text: string; images: string[]; tapped: boolean };
  steps: StepEvent[];
  route?: { expert: ExpertId; action: string; confidence: number }[];
  blocks: Block[];
  actions: SuggestedAction[];
  totalCostUsd?: number;
  done: boolean;
  pending: boolean;
}

interface Spend {
  calls: number;
  todayUsd: number;
  byRole: Record<string, number>;
}

const MAX_IMAGES = 3;
const MAX_SIDE = 1600;
const HISTORY_TURNS = 4;
const SUMMARY_CHARS = 200;

const clip = (s: string, n = SUMMARY_CHARS) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not an image I can read.'));
    img.src = url;
  });
}

/** Shrinks a screenshot to at most 1600 px on the long side as JPEG 0.85, so 3 images stay under the 4.5 MB body limit. */
async function resizeImage(file: Blob): Promise<Attachment> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0, 1));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize images.');
    ctx.fillStyle = '#ffffff'; // transparent PNG areas would turn black in JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { id: Math.random().toString(36).slice(2), mime: 'image/jpeg', b64: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function summarizeUser(t: Turn): string {
  const imgs = t.user.images.length ? `[${t.user.images.length} screenshot${t.user.images.length === 1 ? '' : 's'}] ` : '';
  return clip(`${t.user.tapped ? 'Tapped: ' : ''}${imgs}${t.user.text}`.trim() || '[empty]');
}

function summarizeAssistant(t: Turn): string {
  const parts: string[] = [];
  for (const b of t.blocks) {
    if (b.kind === 'text') parts.push(b.text);
    else if (b.kind === 'banner') parts.push(b.text);
    else if (b.card.kind === 'job') parts.push(`Job card app ${b.card.appId}: ${b.card.company}, ${b.card.title}, ${b.card.score} ${b.card.verdict}`);
    else if (b.card.kind === 'jobs')
      parts.push(`${b.card.heading}: ${b.card.items.slice(0, 3).map((i) => `${i.company} ${i.title} ${i.score ?? '-'}`).join('; ')}`);
    else if (b.card.kind === 'resume') parts.push(`Resume for app ${b.card.appId}: checks ${b.card.pass ? 'passed' : 'failed'}, match ${b.card.matchPct}%`);
    else if (b.card.kind === 'draft') parts.push(`Referral draft for app ${b.card.appId} to ${b.card.contact?.name ?? 'no verified contact'}`);
  }
  return clip(parts.join('. ') || '[no answer]');
}

function buildHistory(turns: Turn[]): TurnSummary[] {
  const out: TurnSummary[] = [];
  for (const t of turns) {
    if (t.pending) continue;
    out.push({ role: 'user', summary: summarizeUser(t) }, { role: 'assistant', summary: summarizeAssistant(t) });
  }
  return out.slice(-HISTORY_TURNS);
}

function pickRole(byRole: Record<string, number>, names: string[]): number {
  return names.reduce((s, n) => s + (Number(byRole[n]) || 0), 0);
}

async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return 'You are signed out. Reload the page and sign in again.';
  if (res.status === 404) return 'The assistant is not available on this deployment yet.';
  if (res.status === 413) return 'Those images are too large. Try one screenshot at a time.';
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    if (j.error || j.message) return String(j.error ?? j.message);
  } catch {
    /* not JSON */
  }
  return `Something went wrong (HTTP ${res.status}). Try again in a moment.`;
}

export default function ChatClient({ demo, initialAppId, notice }: { demo: boolean; initialAppId?: number; notice?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState('');
  const [spend, setSpend] = useState<Spend | null>(null);

  const turnsRef = useRef<Turn[]>([]);
  const lastAppIdRef = useRef<number | undefined>(initialAppId);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const dragDepth = useRef(0);
  const nextId = useRef(1);

  useEffect(() => {
    turnsRef.current = turns;
    if (stickRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  useEffect(() => {
    const onScroll = () => {
      stickRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const refreshSpend = useCallback(async () => {
    try {
      const r = await fetch('/api/spend', { cache: 'no-store' });
      if (!r.ok) return setSpend(null);
      const j = (await r.json()) as Partial<Spend> & { spend?: Partial<Spend> };
      const s = j.spend ?? j;
      setSpend({ calls: Number(s.calls) || 0, todayUsd: Number(s.todayUsd) || 0, byRole: s.byRole ?? {} });
    } catch {
      setSpend(null);
    }
  }, []);

  useEffect(() => {
    void refreshSpend();
  }, [refreshSpend]);

  const patch = (id: number, f: (t: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.id === id ? f(t) : t)));

  function apply(id: number, ev: StreamEvent) {
    switch (ev.type) {
      case 'step':
        return patch(id, (t) => ({ ...t, steps: [...t.steps, ev] }));
      case 'route':
        return patch(id, (t) => ({ ...t, route: ev.intents }));
      case 'card':
        if (ev.card.kind === 'job') lastAppIdRef.current = ev.card.appId;
        return patch(id, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'card', card: ev.card }] }));
      case 'text':
        return patch(id, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'text', text: ev.text }] }));
      case 'banner':
        return patch(id, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'banner', level: ev.level, text: ev.text, link: ev.link }] }));
      case 'error':
        return patch(id, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'banner', level: 'error', text: ev.message }] }));
      case 'actions':
        return patch(id, (t) => ({ ...t, actions: [...t.actions, ...ev.actions] }));
      case 'done':
        if (ev.chain?.appId) lastAppIdRef.current = ev.chain.appId;
        return patch(id, (t) => ({ ...t, done: true, totalCostUsd: ev.totalCostUsd }));
    }
  }

  async function send(opts: { text: string; images?: Attachment[]; action?: ActionRequest; tappedLabel?: string }) {
    if (busy) return;
    const images = opts.images ?? [];
    const msg = opts.text.trim();
    if (!msg && !images.length && !opts.action) return;
    const id = nextId.current++;
    const history = buildHistory(turnsRef.current);
    const req: ChatRequest = {
      text: opts.tappedLabel ?? msg,
      images: images.map(({ mime, b64 }) => ({ mime, b64 })),
      history,
      ...(opts.action ? { action: opts.action } : {}),
      ...(lastAppIdRef.current ? { lastAppId: lastAppIdRef.current } : {}),
    };
    const turn: Turn = {
      id,
      user: { text: opts.tappedLabel ?? msg, images: images.map((i) => i.preview), tapped: !!opts.action },
      steps: [],
      blocks: [],
      actions: [],
      done: false,
      pending: true,
    };
    stickRef.current = true;
    setTurns((prev) => [...prev, turn]);
    setBusy(true);
    setHint('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const m = await errorText(res);
        patch(id, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'banner', level: 'error', text: m }] }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handle = (line: string) => {
        const s = line.trim();
        if (!s) return;
        try {
          apply(id, JSON.parse(s) as StreamEvent);
        } catch {
          /* a malformed line is skipped, the rest of the answer still renders */
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handle(buf + decoder.decode());
    } catch (e) {
      const stopped = (e as Error)?.name === 'AbortError';
      patch(id, (t) => ({
        ...t,
        blocks: [...t.blocks, { kind: 'banner', level: stopped ? 'info' : 'error', text: stopped ? 'Stopped.' : 'The connection dropped. Try again.' }],
      }));
    } finally {
      patch(id, (t) => ({
        ...t,
        pending: false,
        blocks:
          !t.done && t.blocks.length === 0 && !ctrl.signal.aborted
            ? [{ kind: 'banner', level: 'error', text: 'The answer stopped early. Try again.' }]
            : t.blocks,
      }));
      abortRef.current = null;
      setBusy(false);
      void refreshSpend();
    }
  }

  async function addFiles(files: File[]) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) {
      if (files.length) setHint('Only images work here: PNG, JPEG or WebP screenshots.');
      return;
    }
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) return setHint(`Up to ${MAX_IMAGES} images per message.`);
    setHint(imgs.length > room ? `Up to ${MAX_IMAGES} images per message. I kept the first ${room}.` : '');
    try {
      const done = await Promise.all(imgs.slice(0, room).map((f) => resizeImage(f)));
      setAttachments((prev) => [...prev, ...done].slice(0, MAX_IMAGES));
    } catch (e) {
      setHint((e as Error).message);
    }
    inputRef.current?.focus();
  }

  function submit() {
    if (busy) return;
    const imgs = attachments;
    const msg = text;
    if (!msg.trim() && !imgs.length) return;
    setText('');
    setAttachments([]);
    if (inputRef.current) inputRef.current.style.height = '';
    void send({ text: msg, images: imgs });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }
  function onDragLeave(e: DragEvent) {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(Array.from(e.dataTransfer.files));
  }

  async function trySample() {
    if (busy) return;
    try {
      const r = await fetch('/demo/post.png', { cache: 'no-store' });
      const type = r.headers.get('content-type') ?? '';
      if (r.ok && type.startsWith('image/')) {
        const att = await resizeImage(await r.blob());
        await send({ text: '', images: [att] });
        return;
      }
    } catch {
      /* fall through to the file picker */
    }
    fileRef.current?.click();
  }

  // The orchestrator's "Upload a screenshot" button carries note 'upload_screenshot': open the picker, do not call the server.
  const tap = (label: string, request: ActionRequest) =>
    request.args?.note === 'upload_screenshot' ? fileRef.current?.click() : void send({ text: label, action: request, tappedLabel: label });

  const appForPrompt = initialAppId && turns.length === 0 ? initialAppId : undefined;
  const footer = spend
    ? `${spend.calls} call${spend.calls === 1 ? '' : 's'} on Nebius Token Factory: Nano x ${pickRole(spend.byRole, ['fast', 'nano'])}, Ultra x ${pickRole(spend.byRole, ['reason', 'ultra'])}, VL x ${pickRole(spend.byRole, ['vision', 'vl'])}${
        pickRole(spend.byRole, ['fallback', 'lightning']) ? `, Lightning x ${pickRole(spend.byRole, ['fallback', 'lightning'])}` : ''
      }, ${fmtUsd(spend.todayUsd, 3)} today`
    : '';

  return (
    <div className={`ch${dragging ? ' dragging' : ''}`} onDragEnter={onDragEnter} onDragOver={(e) => hasFiles(e) && e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="ch-intro">
        <b>Job Hunt OS.</b> A private job-hunt assistant on NVIDIA Nemotron via Nebius Token Factory.
      </div>
      {notice && <div className="ch-banner info">{notice}</div>}

      <div className="ch-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="ch-empty">
            {appForPrompt ? (
              <>
                <h1>Pick up this job</h1>
                <p className="muted">Ask me to tailor a resume or find someone for this job.</p>
                <div className="ch-chips">
                  <button type="button" className="ch-chip" onClick={() => tap('Tailor my resume for this job', { expert: 'resume', action: 'tailor', args: { appId: appForPrompt } })}>
                    Tailor my resume for this job
                  </button>
                  <button
                    type="button"
                    className="ch-chip"
                    onClick={() => tap('Find someone to ask for a referral', { expert: 'outreach', action: 'find_contact_and_draft', args: { appId: appForPrompt } })}
                  >
                    Find someone to ask
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1>Drop in any job signal</h1>
                <p className="muted">
                  A screenshot of a careers post, a job link, a pasted post or a company name. Three Nemotron experts turn it into a scored lead, a one-page resume
                  checked against your master, and a referral draft with a cited contact.
                </p>
                <div className="ch-chips">
                  <button type="button" className="ch-chip" onClick={() => void trySample()}>
                    Try a job screenshot
                  </button>
                  <button type="button" className="ch-chip" onClick={() => void send({ text: 'What should I apply to today?' })}>
                    What should I apply to today?
                  </button>
                  <button type="button" className="ch-chip" onClick={() => void send({ text: 'Anything open at Grab?' })}>
                    Anything open at Grab?
                  </button>
                </div>
              </>
            )}
            <p className="ch-promise small muted">Nothing leaves without your tap. I never open LinkedIn pages{demo ? ', and personal details are masked in this demo' : ''}.</p>
          </div>
        )}

        {turns.map((t) => (
          <div className="ch-turn" key={t.id}>
            <div className={`ch-user${t.user.tapped ? ' tapped' : ''}`}>
              {t.user.images.length > 0 && (
                <div className="ch-thumbs">
                  {t.user.images.map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={src} alt={`attached screenshot ${i + 1}`} />
                  ))}
                </div>
              )}
              {t.user.text && <div className="ch-user-text">{t.user.text}</div>}
            </div>
            <div className="ch-bot">
              <Trace steps={t.steps} route={t.route} pending={t.pending} totalCostUsd={t.totalCostUsd} />
              {t.blocks.map((b, i) =>
                b.kind === 'card' ? (
                  <CardView key={i} card={b.card} onAction={tap} busy={busy} />
                ) : b.kind === 'text' ? (
                  <div key={i} className="ch-text">
                    {b.text}
                  </div>
                ) : (
                  <div key={i} className={`ch-banner ${b.level}`}>
                    <span>{b.text}</span>
                    {safeHref(b.link) && (
                      <>
                        {' '}
                        <a href={safeHref(b.link)} target="_blank" rel="noopener noreferrer">
                          {b.level === 'warn' ? 'Watch the recorded demo' : 'Open link'}
                        </a>
                      </>
                    )}
                  </div>
                ),
              )}
              {t.actions.length > 0 && (
                <div className="ch-actions">
                  {t.actions.map((a, i) => (
                    <button key={i} type="button" className={`ch-btn${i === 0 ? ' primary' : ''}`} disabled={busy} onClick={() => tap(a.label, a.request)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="ch-dock">
        {dragging && <div className="ch-drop">Drop screenshots to attach (up to {MAX_IMAGES})</div>}
        <div className="ch-composer">
          {attachments.length > 0 && (
            <div className="ch-atts">
              {attachments.map((a) => (
                <div key={a.id} className="ch-att">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.preview} alt="attachment preview" />
                  <button type="button" aria-label="Remove image" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ch-inrow">
            <button
              type="button"
              className="ch-icon-btn"
              aria-label="Attach screenshots"
              title="Attach screenshots"
              disabled={busy || attachments.length >= MAX_IMAGES}
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 20 20" aria-hidden>
                <path
                  d="M13.5 6.5l-6 6a1.8 1.8 0 002.5 2.5l6.2-6.2a3.3 3.3 0 00-4.7-4.7L5.3 10.3a4.8 4.8 0 006.8 6.8l5.4-5.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              className="ch-input"
              rows={1}
              value={text}
              placeholder={busy ? 'Working on it...' : 'Paste a job post, a link or a screenshot, or ask a question'}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-label="Message"
            />
            {busy ? (
              <button type="button" className="ch-btn" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="button" className="ch-btn primary" disabled={!text.trim() && !attachments.length} onClick={submit}>
                Send
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
        <div className="ch-foot">
          {hint ? <span className="ch-hint">{hint}</span> : <span className="muted">Enter sends, Shift+Enter adds a line. Paste or drop up to 3 screenshots.</span>}
          {footer && (
            <span className="ch-spend" title="Model calls made by this app today, all on Nebius Token Factory">
              <span className="ch-live" aria-hidden />
              {footer}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
