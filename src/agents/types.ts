/**
 * Contracts shared by the router, the orchestrator and the three experts (Job Fetcher, Resume, Outreach).
 * The orchestrator is channel-agnostic: it emits StreamEvents and an adapter (web chat now, Telegram later) renders them.
 * Each expert builds its own model messages from its own memory slice; nothing else crosses between experts.
 */
import type { Sql } from '../server/sql';

export type ExpertId = 'job_fetcher' | 'resume' | 'outreach';
export type ActionName = 'add_lead' | 'search_company' | 'show_top' | 'tailor' | 'find_contact_and_draft';

export interface ImageIn {
  mime: string; // image/jpeg | image/png | image/webp
  b64: string; // base64 without the data: prefix
}

export interface ActionArgs {
  company?: string;
  appId?: number;
  appRef?: string; // 'last' or a company name the router heard
  person?: string;
  note?: string; // what the user asked for ("lead with ranking")
  url?: string;
}

export interface ActionRequest {
  expert: ExpertId;
  action: ActionName;
  args: ActionArgs;
}

export interface TurnSummary {
  role: 'user' | 'assistant';
  summary: string; // at most 200 characters
}

export interface ChatRequest {
  text: string;
  images: ImageIn[];
  action?: ActionRequest; // a tapped button: skips the router
  history: TurnSummary[]; // last 4 turns, kept by the client
  lastAppId?: number; // the job the conversation is about, verified by the server before use
}

/** Where the work goes next: what the first expert produced, passed to the buttons it suggests. */
export interface ChainContext {
  appId?: number;
  jobId?: number;
  company?: string;
  person?: string;
}

export type ModelRole = 'fast' | 'reason' | 'vision' | 'fallback';

export interface StepEvent {
  type: 'step';
  expert: ExpertId | 'router' | 'intake' | 'daily';
  label: string; // "Super VL read the screenshot"
  model?: string; // the real Nemotron model ID that answered
  role?: ModelRole;
  ms?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  status: 'ok' | 'fallback' | 'error' | 'skipped';
}

export interface GateCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export type Card =
  | {
      kind: 'job';
      appId: number;
      jobId: number;
      company: string;
      title: string;
      score: number;
      verdict: string;
      gates: Record<string, string>;
      flags: string[];
      notes: string;
      deadline: string;
      url: string;
      model: string;
    }
  | {
      kind: 'jobs';
      heading: string;
      checked: string[];
      items: { appId?: number; jobId: number; company: string; title: string; score: number | null; verdict: string; notes: string; nanoScore?: number | null; ultraScore?: number | null; url: string }[];
    }
  | {
      kind: 'resume';
      appId: number;
      resumeId: number;
      pass: boolean;
      checks: GateCheck[];
      matchPct: number;
      gaps: string[];
      changes: string[];
      downloadUrl: string;
      dropped: number;
      revised: boolean;
      model: string;
    }
  | {
      kind: 'draft';
      appId: number;
      messageId: number | null;
      contact: { name: string; headline: string; sourceUrl: string; evidence: string } | null;
      subject: string;
      emailBody: string;
      linkedinNote: string;
      linkedinSearchUrl: string;
      checks: GateCheck[];
      demo: boolean;
    };

export interface SuggestedAction {
  label: string;
  request: ActionRequest;
}

export type StreamEvent =
  | StepEvent
  | { type: 'route'; intents: { expert: ExpertId; action: ActionName; confidence: number }[]; clarify: string }
  | { type: 'card'; card: Card }
  | { type: 'text'; text: string }
  | { type: 'actions'; actions: SuggestedAction[] }
  | { type: 'banner'; level: 'info' | 'warn'; text: string; link?: string }
  | { type: 'error'; message: string }
  | { type: 'done'; totalCostUsd: number; chain?: ChainContext };

export type BudgetMode = 'normal' | 'saver' | 'stopped';

// ---- model and search clients, injected so tests never touch the network ----

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
  tool_call_id?: string;
  tool_calls?: unknown[];
  name?: string;
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface LlmCall {
  role: ModelRole;
  messages: OpenAIMessage[];
  schema?: { name: string; schema: object }; // structured JSON output
  tools?: OpenAITool[];
  toolChoice?: 'auto' | 'required';
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean; // reasoning on (judge) or off (JSON drafting)
  timeoutMs: number;
  tag: { expert: string; step: string }; // written to runs.step as llm:<expert>:<step>
  label?: string; // trace label; when set, chat() emits a StepEvent
  emit?: (e: StreamEvent) => void;
}

export interface LlmResult {
  content: string;
  json?: unknown; // parsed when a schema was given
  toolCalls?: { id: string; name: string; args: unknown }[];
  model: string;
  role: ModelRole;
  usage: { in: number; out: number };
  ms: number;
  costUsd: number;
  fallbackUsed: boolean;
}

export type LlmClient = (call: LlmCall) => Promise<LlmResult>;

export interface WebResult {
  title: string;
  url: string;
  description?: string; // Tavily "content" snippet
}

export interface TavilyClient {
  search(q: string, o?: { includeDomains?: string[]; excludeDomains?: string[]; maxResults?: number; depth?: 'basic' | 'advanced' }): Promise<WebResult[]>;
  extract(urls: string[]): Promise<{ url: string; text: string }[]>;
}

export interface ExpertCtx {
  sql: Sql;
  today: string; // YYYY-MM-DD (SGT)
  demo: boolean;
  deadlineMs: number; // absolute Date.now() deadline for this turn
  emit: (e: StreamEvent) => void;
  llm: LlmClient;
  tavily: TavilyClient;
  budgetMode: BudgetMode;
}

export interface ExpertResult {
  chain?: ChainContext;
  actions?: SuggestedAction[];
}

export interface Expert {
  id: ExpertId;
  /** Instructions given to this expert's models, shown on /memory. */
  describe(): { purpose: string; sees: string[]; neverSees: string[]; models: string[]; tools: string[] };
  run(ctx: ExpertCtx, req: ActionRequest, input: ChatRequest, chain: ChainContext): Promise<ExpertResult>;
}
