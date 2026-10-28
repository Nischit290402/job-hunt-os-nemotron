import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'job-hunt-os' });

/** Event names. data always carries applicationId (a number). */
export const EV = {
  apply: 'app/apply',
  outreachDecided: 'app/outreach.decided', // data.decision: 'sent' | 'dropped'
  replied: 'app/outreach.replied',
  submitted: 'app/submitted',
  rejudge: 'jobs/rejudge',
  resumeDone: 'worker/resume.done', // tailored resume saved, or tailoring gave up
  workerIdle: 'worker/idle', // a worker run emptied the queue
} as const;

export async function emit(name: string, data: Record<string, unknown>) {
  await inngest.send({ name, data });
}
