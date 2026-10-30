/**
 * Channel-agnostic orchestrator: one chat turn in, StreamEvents out. Adapters (web NDJSON now, Telegram later) render them.
 * Order: budget guard -> verify lastAppId -> tapped action, or intake rules, or the router -> run ONLY intent #1 ->
 * intents 2-3 become one-tap buttons pre-filled from the chain the first expert returned.
 * Experts receive (ctx, request, input, chain) and nothing else: no history, no other expert's memory.
 */
import type { Sql } from '../server/sql';
import type {
  ActionArgs,
  ActionName,
  ActionRequest,
  BudgetMode,
  ChainContext,
  ChatRequest,
  Expert,
  ExpertCtx,
  ExpertId,
  ImageIn,
  LlmClient,
  StreamEvent,
  SuggestedAction,
  TavilyClient,
  TurnSummary,
} from './types';
import { budgetMode as realBudgetMode, llmFor, LlmCapError } from '../server/nebius';
import { tavilyFor } from '../server/tavily';
import * as repo from '../server/repo';
import { env } from '../server/env';
import { sgtDate } from '../core/time';
import { classifyIntake, LINKEDIN_REPLY, type Intake, type IntakeRule } from '../core/intake';
import { ACTION_EXPERT, actionLabel, route, type LastApp, type RouterIntent, type RouterOut } from './router';
import { jobFetcher } from './jobFetcher';
import { resume } from './resume';
import { outreach } from './outreach';

export type IntakeLike = Intake;

export interface TurnDeps {
  llm?: LlmClient;
  tavily?: TavilyClient;
  experts?: Partial<Record<ExpertId, Expert>>;
  now?: () => number;
  /** Tests only: a fixed budget mode (or a check), and the intake rules. */
  budget?: BudgetMode | ((sql: Sql, today: string) => Promise<BudgetMode>);
  classify?: (req: ChatRequest) => IntakeLike;
}

export const STOPPED_TEXT = "Today's demo budget is used. Here is the recorded demo.";
export const SAVER_TEXT = 'Budget saver: heavy steps use Nemotron Nano for the rest of today.';
export const TURN_BUDGET_MS = 240_000;
const EXECUTE_AT = 0.6;
const CLARIFY_AT = 0.4;

/** Marker the chat client turns into a file picker: args.note === UPLOAD_NOTE. */
export const UPLOAD_NOTE = 'upload_screenshot';
export const UPLOAD_ACTION: SuggestedAction = {
  label: 'Upload a screenshot',
  request: { expert: 'job_fetcher', action: 'add_lead', args: { note: UPLOAD_NOTE } },
};

export function capabilityActions(): SuggestedAction[] {
  const caps: SuggestedAction[] = [
    { label: 'Try a job screenshot', request: { expert: 'job_fetcher', action: 'add_lead', args: { note: UPLOAD_NOTE } } },
    { label: 'What should I apply to today?', request: { expert: 'job_fetcher', action: 'show_top', args: {} } },
  ];
  if (env.featureSearch()) caps.push({ label: 'Anything open at Grab?', request: { expert: 'job_fetcher', action: 'search_company', args: { company: 'Grab' } } });
  return caps;
}

const DEFAULT_REPLY = 'I can score a job from a screenshot, link or pasted post, tailor your resume for it, and draft a referral ask. Try one of these.';

const INTAKE_LABEL: Record<IntakeRule, string> = {
  R0: 'Intake: no rule matched, asking the router',
  R1: 'Intake: screenshot, so add it as a lead',
  R2: 'Intake: job link, so add it as a lead',
  R3: 'Intake: LinkedIn link, never opened',
  R4: 'Intake: pasted job post, so add it as a lead',
};

const DOING: Record<ActionName, string> = {
  add_lead: 'reading that job',
  search_company: 'searching that company',
  show_top: 'loading your top jobs',
  tailor: 'tailoring your resume',
  find_contact_and_draft: 'finding a contact and drafting the ask',
};

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const withoutUrls = (s: string) => s.replace(/https?:\/\/\S+/gi, ' ');
const needsApp = (a: ActionName) => a === 'tailor' || a === 'find_contact_and_draft';
const LAST_REFS = new Set(['', 'last', 'this', 'it', 'that', 'this one', 'that one']);

export async function runTurn(sql: Sql, req: ChatRequest, emit: (e: StreamEvent) => void, deps: TurnDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  let total = 0;
  let chain: ChainContext = {};
  const out = (e: StreamEvent) => {
    if (e.type === 'step' && typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) total += e.costUsd;
    try {
      emit(e);
    } catch {
      // the client went away; keep going so the work still lands in the database
    }
  };
  let doing = 'handling that';
  try {
    const today = sgtDate(now());
    const b = deps.budget ?? realBudgetMode;
    const mode: BudgetMode = typeof b === 'function' ? await b(sql, today) : b;
    if (mode === 'stopped') {
      out(stoppedBanner());
      return;
    }
    if (mode === 'saver') out({ type: 'banner', level: 'info', text: SAVER_TEXT });

    const ctx: ExpertCtx = {
      sql,
      today,
      demo: env.demoMode(),
      deadlineMs: now() + TURN_BUDGET_MS,
      emit: out,
      llm: deps.llm ?? llmFor(sql),
      tavily: deps.tavily ?? tavilyFor(sql),
      budgetMode: mode,
    };
    const experts: Record<ExpertId, Expert> = { job_fetcher: jobFetcher, resume, outreach, ...deps.experts };

    // The client keeps lastAppId; trust it only if the application exists.
    const lastRow = Number.isInteger(req.lastAppId) && (req.lastAppId as number) > 0 ? await repo.getApplication(sql, req.lastAppId as number) : null;
    const lastApp: LastApp | null = lastRow ? { id: lastRow.id, company: lastRow.company, title: lastRow.title } : null;
    // Experts get the message itself, never the conversation history.
    const input: ChatRequest = { text: req.text, images: req.images, history: [], lastAppId: lastApp?.id };

    const execute = async (a: ActionRequest, extras: RouterIntent[], chainOwnsApp: boolean): Promise<void> => {
      doing = DOING[a.action];
      let request: ActionRequest = { expert: ACTION_EXPERT[a.action], action: a.action, args: { ...a.args } };
      if (needsApp(a.action)) {
        const app = await resolveApp(sql, request.args, lastApp);
        if (!app) {
          await askWhichJob(sql, request, out);
          return;
        }
        request = { ...request, args: { ...request.args, appId: app.id, company: app.company } };
      }
      const chainIn: ChainContext = clean({ appId: request.args.appId, company: request.args.company, person: request.args.person });
      const res = await experts[request.expert].run(ctx, request, input, chainIn);
      chain = clean({ ...chainIn, ...(res.chain ?? {}) });

      const suggested: SuggestedAction[] = extras.map((it) => toSuggestion(it, chain, chainOwnsApp));
      if (request.action === 'add_lead' && chain.appId) {
        suggested.push(
          ...(['tailor', 'find_contact_and_draft'] as const).map((act) => toSuggestion({ expert: ACTION_EXPERT[act], action: act, confidence: 1, args: {} }, chain, true)),
        );
      }
      // Router suggestions first (they carry the user's note), then the expert's own, then the defaults.
      const merged = dedupe([...suggested.slice(0, extras.length), ...(res.actions ?? []), ...suggested.slice(extras.length)]);
      if (merged.length) out({ type: 'actions', actions: merged });
    };

    if (req.action) {
      const a = req.action;
      if (a.action === 'add_lead' && !req.images.length && !req.text.trim() && !a.args.url) {
        out({ type: 'text', text: 'Attach a screenshot of the post, or paste its text or link, and send it.' });
        out({ type: 'actions', actions: [UPLOAD_ACTION] });
        return;
      }
      await execute(a, [], false);
      return;
    }

    const intake = (deps.classify ?? classifyIntake)(req);
    out({ type: 'step', expert: 'intake', label: INTAKE_LABEL[intake.rule] ?? INTAKE_LABEL.R0, ms: 0, status: 'ok' });

    if (intake.rule === 'R3') {
      out({ type: 'text', text: LINKEDIN_REPLY });
      out({ type: 'actions', actions: [UPLOAD_ACTION] });
      return;
    }

    if (intake.rule === 'R1' || intake.rule === 'R2' || intake.rule === 'R4') {
      const leadArgs: ActionArgs = intake.rule === 'R2' && intake.urls.length ? { url: firstNonLinkedIn(intake) } : {};
      const extraText = withoutUrls(req.text);
      // The router only adds chained intents, so it runs only when the text says more than the attachment.
      const askRouter = intake.rule === 'R1' ? words(extraText) >= 4 : words(extraText) >= 2;
      let extras: RouterIntent[] = [];
      if (askRouter) {
        const r = await route(ctx, req, intake, lastApp);
        emitRoute(out, r);
        const top = sortIntents(r.intents)[0];
        // A link or post plus "tailor my Grab application" means work on that existing app, not a new lead.
        if (intake.rule !== 'R1' && top && needsApp(top.action) && top.confidence >= EXECUTE_AT && explicitRef(top.args.appRef)) {
          const app = await resolveApp(sql, top.args, lastApp);
          if (app) {
            const rest = sortIntents(r.intents).slice(1).filter((i) => i.action !== 'add_lead');
            await execute({ expert: top.expert, action: top.action, args: top.args }, rest, false);
            if (leadArgs.url) out({ type: 'actions', actions: [{ label: 'Add this job', request: { expert: 'job_fetcher', action: 'add_lead', args: leadArgs } }] });
            return;
          }
        }
        extras = sortIntents(r.intents)
          .filter((i) => i.action !== 'add_lead' && i.confidence >= CLARIFY_AT)
          .slice(0, 2);
      }
      await execute({ expert: 'job_fetcher', action: 'add_lead', args: leadArgs }, extras, true);
      return;
    }

    // R0: nothing deterministic matched, so the router decides.
    doing = 'reading your message';
    const r = await route(ctx, req, intake, lastApp);
    emitRoute(out, r);
    const intents = sortIntents(r.intents);
    const top = intents[0];
    if (!top || top.confidence < CLARIFY_AT) {
      out({ type: 'text', text: r.reply || DEFAULT_REPLY });
      out({ type: 'actions', actions: capabilityActions() });
      return;
    }
    if (top.confidence < EXECUTE_AT) {
      out({ type: 'text', text: r.clarify || 'Which of these did you mean?' });
      const chips = intents
        .filter((i) => i.confidence >= CLARIFY_AT)
        .map((i) => {
          const args: ActionArgs = { ...i.args };
          if (needsApp(i.action) && lastApp && LAST_REFS.has((args.appRef ?? '').toLowerCase())) args.appId = lastApp.id;
          return { label: actionLabel({ expert: i.expert, action: i.action, args: labelArgs(args) }), request: { expert: i.expert, action: i.action, args } };
        });
      out({ type: 'actions', actions: dedupe(chips) });
      return;
    }
    await execute({ expert: top.expert, action: top.action, args: top.args }, intents.slice(1, 3), false);
  } catch (e) {
    if (e instanceof LlmCapError) out(stoppedBanner());
    else {
      console.error('chat turn failed:', e instanceof Error ? e.message.slice(0, 300) : 'unknown error');
      out({ type: 'error', message: `Something went wrong while ${doing}. Try again in a minute.` });
    }
  } finally {
    const c = clean(chain);
    out({ type: 'done', totalCostUsd: Math.round(total * 1e6) / 1e6, chain: Object.keys(c).length ? c : undefined });
  }
}

function stoppedBanner(): StreamEvent {
  const link = env.videoUrl();
  return link ? { type: 'banner', level: 'warn', text: STOPPED_TEXT, link } : { type: 'banner', level: 'warn', text: STOPPED_TEXT };
}

function emitRoute(out: (e: StreamEvent) => void, r: RouterOut) {
  out({ type: 'route', intents: r.intents.map((i) => ({ expert: i.expert, action: i.action, confidence: i.confidence })), clarify: r.clarify });
}

const ORDER: Record<ActionName, number> = { add_lead: 0, search_company: 1, show_top: 1, tailor: 2, find_contact_and_draft: 3 };

/** Highest confidence first; among intents that would execute, producers (add_lead) go before consumers (tailor). */
export function sortIntents(intents: RouterIntent[]): RouterIntent[] {
  const sure = intents.filter((i) => i.confidence >= EXECUTE_AT).sort((a, b) => ORDER[a.action] - ORDER[b.action] || b.confidence - a.confidence);
  const rest = intents.filter((i) => i.confidence < EXECUTE_AT).sort((a, b) => b.confidence - a.confidence);
  return [...sure, ...rest];
}

function firstNonLinkedIn(intake: IntakeLike): string | undefined {
  const li = new Set(intake.linkedinUrls);
  return intake.urls.find((u) => !li.has(u));
}

const explicitRef = (ref?: string) => !!ref && !LAST_REFS.has(ref.trim().toLowerCase());

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T;
}

function labelArgs(args: ActionArgs): ActionArgs {
  const ref = args.appRef?.trim();
  if (args.company || !ref || LAST_REFS.has(ref.toLowerCase()) || /^\d+$/.test(ref)) return args;
  return { ...args, company: ref }; // "tailor for the Grab one" -> appRef "Grab"
}

/** A router intent after the first becomes a button. The chain wins over the router's reference when the first step made the app. */
function toSuggestion(it: RouterIntent, chain: ChainContext, chainOwnsApp: boolean): SuggestedAction {
  const args: ActionArgs = { ...it.args };
  const ref = (args.appRef ?? '').trim().toLowerCase();
  const sameCompany = !!chain.company && !!ref && chain.company.toLowerCase().startsWith(ref);
  if (needsApp(it.action) && chain.appId && (chainOwnsApp || !explicitRef(args.appRef) || sameCompany || ref === String(chain.appId))) {
    args.appId = chain.appId;
    args.company = chain.company ?? args.company;
    delete args.appRef;
  }
  if (it.action === 'find_contact_and_draft' && !args.person && chain.person) args.person = chain.person;
  const request: ActionRequest = { expert: ACTION_EXPERT[it.action], action: it.action, args: clean(args) };
  return { label: actionLabel({ ...request, args: labelArgs(request.args) }), request };
}

export function dedupe(actions: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const k = `${a.request.expert}:${a.request.action}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** appId, then 'last'/'this', then digits, then the newest application at a named company. */
async function resolveApp(sql: Sql, args: ActionArgs, lastApp: LastApp | null): Promise<{ id: number; company: string } | null> {
  if (Number.isInteger(args.appId) && (args.appId as number) > 0) {
    const a = await repo.getApplication(sql, args.appId as number);
    if (a) return { id: a.id, company: a.company };
  }
  const ref = (args.appRef ?? '').trim();
  if (LAST_REFS.has(ref.toLowerCase())) {
    // "tailor for Grab" may arrive as company with no appRef; the last job only counts if it is at that company.
    const other = !ref && args.company && lastApp && lastApp.company.toLowerCase() !== args.company.toLowerCase();
    if (lastApp && !other) return { id: lastApp.id, company: lastApp.company };
    if (!args.company) return null;
  }
  if (/^\d+$/.test(ref)) {
    const a = await repo.getApplication(sql, Number(ref));
    return a ? { id: a.id, company: a.company } : null;
  }
  const name = (LAST_REFS.has(ref.toLowerCase()) ? args.company ?? '' : ref).trim().slice(0, 80);
  if (!name) return null;
  const rows = await sql<{ id: number; company: string }>`
    SELECT a.id, j.company FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.user_id = ${repo.USER} AND (lower(j.company) = lower(${name}) OR lower(j.company) LIKE lower(${name}) || '%')
    ORDER BY (lower(j.company) = lower(${name})) DESC, a.id DESC LIMIT 1`;
  return rows[0] ? { id: Number(rows[0].id), company: rows[0].company } : null;
}

/** Tailor or outreach without a known job: offer the newest Today jobs as one-tap choices. */
async function askWhichJob(sql: Sql, request: ActionRequest, out: (e: StreamEvent) => void) {
  const rows = await sql<{ id: number; company: string }>`
    SELECT a.id, j.company FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.user_id = ${repo.USER} AND a.state = 'today' ORDER BY a.id DESC LIMIT 3`;
  const who = request.args.company ? ` at ${request.args.company}` : '';
  out({ type: 'text', text: `Which job${who} do you mean? Send a screenshot or link of it, or pick one below.` });
  const picks: SuggestedAction[] = rows.map((r) => {
    const args: ActionArgs = { ...request.args, appId: Number(r.id), company: r.company };
    delete args.appRef;
    return { label: actionLabel({ ...request, args }), request: { ...request, args } };
  });
  const more: SuggestedAction[] = [];
  if (request.args.company && env.featureSearch()) more.push({ label: `Search ${request.args.company}`, request: { expert: 'job_fetcher', action: 'search_company', args: { company: request.args.company } } });
  out({ type: 'actions', actions: [...picks, ...more, UPLOAD_ACTION] });
}

// ---------------- request validation (used by app/api/chat/route.ts) ----------------

export const LIMITS = { text: 8000, images: 3, imageB64: 1.5 * 1024 * 1024, history: 4, summary: 200 };
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXPERTS = new Set<ExpertId>(['job_fetcher', 'resume', 'outreach']);

export type Parsed = { ok: true; req: ChatRequest } | { ok: false; error: string };

export function parseChatRequest(body: unknown): Parsed {
  const fail = (error: string): Parsed => ({ ok: false, error });
  if (!body || typeof body !== 'object') return fail('send a JSON object');
  const b = body as Record<string, unknown>;

  const text = b.text === undefined ? '' : b.text;
  if (typeof text !== 'string') return fail('text must be a string');
  if (text.length > LIMITS.text) return fail(`text is longer than ${LIMITS.text} characters`);

  const imagesIn = b.images === undefined ? [] : b.images;
  if (!Array.isArray(imagesIn)) return fail('images must be a list');
  if (imagesIn.length > LIMITS.images) return fail(`at most ${LIMITS.images} images`);
  const images: ImageIn[] = [];
  for (const im of imagesIn) {
    if (!im || typeof im !== 'object') return fail('bad image');
    const { mime, b64 } = im as Record<string, unknown>;
    if (typeof mime !== 'string' || !MIMES.has(mime)) return fail('images must be JPEG, PNG or WebP');
    if (typeof b64 !== 'string' || !b64) return fail('bad image data');
    const data = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
    if (data.length > LIMITS.imageB64) return fail('an image is larger than 1.5 MB');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return fail('bad image data');
    images.push({ mime, b64: data });
  }

  const histIn = b.history === undefined ? [] : b.history;
  if (!Array.isArray(histIn)) return fail('history must be a list');
  if (histIn.length > LIMITS.history) return fail(`history holds at most ${LIMITS.history} turns`);
  const history: TurnSummary[] = [];
  for (const h of histIn) {
    const { role, summary } = (h ?? {}) as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') return fail('bad history role');
    if (typeof summary !== 'string' || summary.length > LIMITS.summary) return fail(`history summaries are at most ${LIMITS.summary} characters`);
    history.push({ role: role as TurnSummary['role'], summary });
  }

  let lastAppId: number | undefined;
  if (b.lastAppId !== undefined && b.lastAppId !== null) {
    if (!Number.isInteger(b.lastAppId) || (b.lastAppId as number) <= 0) return fail('bad lastAppId');
    lastAppId = b.lastAppId as number;
  }

  let action: ActionRequest | undefined;
  if (b.action !== undefined && b.action !== null) {
    const a = b.action as Record<string, unknown>;
    if (typeof a !== 'object') return fail('bad action');
    const name = a.action as ActionName;
    if (!(name in ACTION_EXPERT)) return fail('unknown action');
    if (typeof a.expert !== 'string' || !EXPERTS.has(a.expert as ExpertId) || ACTION_EXPERT[name] !== a.expert) return fail('action and expert do not match');
    const argsIn = (a.args ?? {}) as Record<string, unknown>;
    if (typeof argsIn !== 'object') return fail('bad action args');
    const args: ActionArgs = {};
    for (const k of ['company', 'appRef', 'person', 'note', 'url'] as const) {
      const v = argsIn[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || v.length > (k === 'url' ? 2000 : 300)) return fail(`bad action ${k}`);
      args[k] = v;
    }
    if (argsIn.appId !== undefined && argsIn.appId !== null) {
      if (!Number.isInteger(argsIn.appId) || (argsIn.appId as number) <= 0) return fail('bad action appId');
      args.appId = argsIn.appId as number;
    }
    action = { expert: a.expert as ExpertId, action: name, args };
  }

  if (!action && !text.trim() && !images.length) return fail('send a message, a link or a screenshot');
  return { ok: true, req: { text, images, history, ...(action ? { action } : {}), ...(lastAppId ? { lastAppId } : {}) } };
}
