/**
 * Application state machine. Only the workflow engine calls transition(); taps and services send events.
 * Keeping every allowed move in one table is what stops two writers from disagreeing (the Sheet vs tracker xlsx bug).
 */

export const STATES = [
  'today', // picked for the brief, waiting for your decision
  'snoozed',
  'skipped',
  'tailoring', // you said Apply; resume being generated
  'finding_contact',
  'awaiting_send', // referral draft waiting for your Send tap
  'ask_sent', // referral sent; waiting 3 days or for a reply
  'ready_to_fill', // queued for the laptop agent
  'prefilled', // form filled, waiting for you to click Submit
  'applied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
] as const;
export type AppState = (typeof STATES)[number];

export const EVENTS = [
  'decide.apply',
  'decide.skip',
  'decide.snooze',
  'snooze.due',
  'resume.ready',
  'resume.unavailable', // resume service not configured or failed: continue with your base resume
  'contact.found',
  'contact.none',
  'outreach.sent',
  'outreach.dropped',
  'wait.elapsed',
  'reply.received',
  'prefill.done',
  'prefill.failed',
  'submitted',
  'outcome.interview',
  'outcome.offer',
  'outcome.rejected',
  'withdraw',
] as const;
export type AppEvent = (typeof EVENTS)[number];

export interface TransitionContext {
  snoozeCount: number;
}

export interface TransitionResult {
  state: AppState;
  /** Set when a snooze turned into a skip, so the caller can record the reason. */
  note?: string;
}

const ACTIVE: AppState[] = ['tailoring', 'finding_contact', 'awaiting_send', 'ask_sent', 'ready_to_fill', 'prefilled'];
const TERMINAL: AppState[] = ['skipped', 'offer', 'rejected', 'withdrawn'];

export class TransitionError extends Error {}

export function transition(from: AppState, event: AppEvent, ctx: TransitionContext = { snoozeCount: 0 }): TransitionResult {
  const bad = () => {
    throw new TransitionError(`event ${event} is not allowed in state ${from}`);
  };
  switch (event) {
    case 'decide.apply':
      return from === 'today' || from === 'snoozed' ? { state: 'tailoring' } : bad();
    case 'decide.skip':
      return from === 'today' || from === 'snoozed' ? { state: 'skipped' } : bad();
    case 'decide.snooze':
      if (from !== 'today') return bad();
      // A second snooze is a decision not to apply.
      return ctx.snoozeCount >= 1 ? { state: 'skipped', note: 'snoozed twice' } : { state: 'snoozed' };
    case 'snooze.due':
      return from === 'snoozed' ? { state: 'today' } : bad();
    case 'resume.ready':
    case 'resume.unavailable':
      return from === 'tailoring' ? { state: 'finding_contact' } : bad();
    case 'contact.found':
      return from === 'finding_contact' ? { state: 'awaiting_send' } : bad();
    case 'contact.none':
      return from === 'finding_contact' ? { state: 'ready_to_fill' } : bad();
    case 'outreach.sent':
      return from === 'awaiting_send' ? { state: 'ask_sent' } : bad();
    case 'outreach.dropped':
      return from === 'awaiting_send' ? { state: 'ready_to_fill' } : bad();
    case 'wait.elapsed':
    case 'reply.received':
      return from === 'ask_sent' ? { state: 'ready_to_fill' } : bad();
    case 'prefill.done':
      return from === 'ready_to_fill' ? { state: 'prefilled' } : bad();
    case 'prefill.failed':
      return from === 'ready_to_fill' ? { state: 'ready_to_fill', note: 'fill manually' } : bad();
    case 'submitted':
      // You can apply by hand at any point after deciding; the system catches up.
      return ACTIVE.includes(from) ? { state: 'applied' } : bad();
    case 'outcome.interview':
      return from === 'applied' || from === 'interview' ? { state: 'interview' } : bad();
    case 'outcome.offer':
      return from === 'applied' || from === 'interview' ? { state: 'offer' } : bad();
    case 'outcome.rejected':
      return from === 'applied' || from === 'interview' ? { state: 'rejected' } : bad();
    case 'withdraw':
      return TERMINAL.includes(from) ? bad() : { state: 'withdrawn' };
    default:
      return bad();
  }
}

export const isActive = (s: AppState) => ACTIVE.includes(s) || s === 'applied' || s === 'interview';
export const isTerminal = (s: AppState) => TERMINAL.includes(s);

/** Columns of the Pipeline page, in order. */
export const PIPELINE_COLUMNS: { title: string; states: AppState[] }[] = [
  { title: 'Deciding', states: ['today', 'snoozed'] },
  { title: 'Preparing', states: ['tailoring', 'finding_contact', 'awaiting_send'] },
  { title: 'Referral wait', states: ['ask_sent'] },
  { title: 'Ready to submit', states: ['ready_to_fill', 'prefilled'] },
  { title: 'Applied', states: ['applied'] },
  { title: 'Interview', states: ['interview'] },
  { title: 'Closed', states: ['offer', 'rejected', 'withdrawn', 'skipped'] },
];
