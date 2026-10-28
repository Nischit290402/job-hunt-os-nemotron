/**
 * Apply-assist agent for your laptop. Start it when you sit down (or at login); it asks Job Hunt OS for applications
 * waiting to be filled, opens each in your own Chrome profile, fills the form, attaches the tailored resume and stops.
 * You review and click Submit yourself, then tap "I submitted it" in Telegram.
 *
 *   cd agent && npm install && npm start
 *
 * Env (agent/.env or your shell):
 *   JOBHUNT_URL          https://your-app.vercel.app
 *   AGENT_TOKEN          same value as the app's AGENT_TOKEN
 *   CHROME_PROFILE_DIR   a dedicated profile folder, e.g. C:\Users\you\JobHuntChrome (sign in to ATS sites there once)
 *   ANSWERS_FILE         defaults to ./answers.local.json (copy answers.example.json)
 *   AGENT_BROWSER        chrome (default) or chromium
 *   MASTER_VAULT         your canonical master, default E:\Projects\vault\AboutMe\Master Resume MD.md
 *   MASTER_TAGGED        the Resume Optimizer copy fact_check.py reads, default E:\Projects\Resume Optimizer\master_resume.md
 *
 * The agent also pushes both master files to the app whenever either changes, so tailored resumes always use your
 * latest vault. `npm run sync-master` does only that and exits (no browser).
 */
import { chromium, type BrowserContext } from 'playwright';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillForm, type Answers } from './fill';

const BASE = (process.env.JOBHUNT_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_TOKEN ?? '';
const PROFILE = process.env.CHROME_PROFILE_DIR ?? join(process.cwd(), '.chrome-profile');
const ANSWERS = process.env.ANSWERS_FILE ?? join(process.cwd(), 'answers.local.json');
const POLL_MS = 60_000;
const MASTER_VAULT = process.env.MASTER_VAULT ?? 'E:\\Projects\\vault\\AboutMe\\Master Resume MD.md';
const MASTER_TAGGED = process.env.MASTER_TAGGED ?? 'E:\\Projects\\Resume Optimizer\\master_resume.md';
const SYNC_ONLY = process.argv.includes('--sync-master');

if (!BASE || !TOKEN) {
  console.error('Set JOBHUNT_URL and AGENT_TOKEN.');
  process.exit(1);
}

const auth = { authorization: `Bearer ${TOKEN}` };

let lastMasterKey = '';

/** Pushes both master files when their content changed since the last push. Never throws. */
export async function syncMaster(log = false): Promise<void> {
  try {
    if (!existsSync(MASTER_VAULT)) {
      if (log) console.error(`Master not found: ${MASTER_VAULT} (set MASTER_VAULT)`);
      return;
    }
    const vault = readFileSync(MASTER_VAULT, 'utf8');
    const tagged = existsSync(MASTER_TAGGED) ? readFileSync(MASTER_TAGGED, 'utf8') : '';
    const key = createHash('sha256').update(vault).update('\u0000').update(tagged).digest('hex');
    if (key === lastMasterKey) return;
    const r = await fetch(`${BASE}/api/agent/master`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        vault,
        tagged,
        vaultModified: statSync(MASTER_VAULT).mtime.toISOString(),
        taggedModified: tagged ? statSync(MASTER_TAGGED).mtime.toISOString() : new Date(0).toISOString(),
      }),
    });
    if (!r.ok) throw new Error(`master sync ${r.status}`);
    lastMasterKey = key;
    const d = (await r.json()) as { changed: boolean };
    if (log || d.changed) console.log(d.changed ? 'Master resume synced.' : 'Master resume already up to date.');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  }
}

if (SYNC_ONLY) {
  await syncMaster(true);
  process.exit(0);
}

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
    await syncMaster();
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
