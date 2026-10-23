/**
 * Apply-assist agent for your laptop. Start it when you sit down (or at login); it asks Job Hunt OS for applications
 * waiting to be filled, opens each in your own Chrome profile, fills the form, attaches the tailored resume and stops.
 * You review and click Submit yourself, then tap "I submitted it" in Telegram.
 *
 *   cd agent && npm install && npx tsx agent.ts
 *
 * Env (agent/.env or your shell):
 *   JOBHUNT_URL          https://your-app.vercel.app
 *   AGENT_TOKEN          same value as the app's AGENT_TOKEN
 *   CHROME_PROFILE_DIR   a dedicated profile folder, e.g. C:\Users\you\JobHuntChrome (sign in to ATS sites there once)
 *   ANSWERS_FILE         defaults to ./answers.local.json (copy answers.example.json)
 *   AGENT_BROWSER        chrome (default) or chromium
 */
import { chromium, type BrowserContext } from 'playwright';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillForm, type Answers } from './fill';

const BASE = (process.env.JOBHUNT_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_TOKEN ?? '';
const PROFILE = process.env.CHROME_PROFILE_DIR ?? join(process.cwd(), '.chrome-profile');
const ANSWERS = process.env.ANSWERS_FILE ?? join(process.cwd(), 'answers.local.json');
const POLL_MS = 60_000;

if (!BASE || !TOKEN) {
  console.error('Set JOBHUNT_URL and AGENT_TOKEN.');
  process.exit(1);
}

const auth = { authorization: `Bearer ${TOKEN}` };
const answers: Answers = JSON.parse(readFileSync(ANSWERS, 'utf8'));

async function nextTask() {
  const r = await fetch(`${BASE}/api/agent/next`, { headers: auth });
  if (!r.ok) throw new Error(`next: ${r.status}`);
  return (await r.json()) as { task: null | { applicationId: number; company: string; title: string; applyUrl: string; resumeUrl: string | null }; paused?: boolean };
}

async function report(applicationId: number, status: 'prefilled' | 'failed', note: string, missing: string[] = []) {
  await fetch(`${BASE}/api/agent/report`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ applicationId, status, note, missing }) });
}

async function downloadResume(url: string): Promise<string> {
  const r = await fetch(url, { headers: auth });
  if (!r.ok) throw new Error(`resume download ${r.status}`);
  const path = join(mkdtempSync(join(tmpdir(), 'jh-')), 'Nischit_Hosamani_Resume.pdf');
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

async function main() {
  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: process.env.AGENT_BROWSER === 'chromium' ? undefined : 'chrome',
    viewport: null,
  });
  console.log(`Agent running against ${BASE}. Leave this window open; close it to stop.`);
  for (;;) {
    try {
      const { task, paused } = await nextTask();
      if (paused) console.log('Paused from Telegram; waiting.');
      if (task) {
        console.log(`Filling ${task.company}: ${task.title}`);
        const resume = task.resumeUrl ? await downloadResume(task.resumeUrl) : null;
        const page = await ctx.newPage();
        try {
          await page.goto(task.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForTimeout(3000);
          // Many boards show the form after an "Apply" button; click it if it is the only one.
          const applyBtn = page.getByRole('button', { name: /^apply( now| for this job)?$/i }).or(page.getByRole('link', { name: /^apply( now| for this job)?$/i }));
          if ((await applyBtn.count()) === 1) {
            await applyBtn.first().click();
            await page.waitForTimeout(3000);
          }
          const r = await fillForm(page, answers, resume);
          if (!r.filled.length && !r.resumeAttached) {
            await report(task.applicationId, 'failed', 'no form fields recognised (sign-in page or multi-step form?)');
          } else {
            await report(task.applicationId, 'prefilled', `filled ${r.filled.length} fields${r.resumeAttached ? ', resume attached' : ''}`, r.missing);
          }
          await page.bringToFront();
        } catch (e) {
          await report(task.applicationId, 'failed', e instanceof Error ? e.message.slice(0, 200) : String(e));
        }
        continue; // check for another task right away
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
