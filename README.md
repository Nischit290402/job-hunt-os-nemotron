# Job Hunt OS

One product for the whole job search: it finds roles, scores them, tailors your resume, finds someone to ask for a referral, drafts the ask, waits, pre-fills the application, and hands it to you to submit. You run it from Telegram in about 5 to 10 minutes each morning.

**Every outward action needs your tap.** The system never sends an email, a LinkedIn request or an application on its own.

Design doc: [Job Hunt OS: System Design (HLD v1)](https://claude.ai/artifact/WGNzqqeCndvgkUXVoBdnvy)

## How a day works

| Time (SGT) | What happens |
| --- | --- |
| 05:00 | Collect from every source (ATS APIs, MyCareersFuture, lists, Firecrawl pages), one step per source |
| 05:00+ | Fetch missing job descriptions (MCF, SmartRecruiters and Workday APIs, then HTML, then Firecrawl for Singapore internships) |
| 07:00 | Judge new jobs with Claude (score, gates, flags, deadline) |
| 07:45 | Telegram brief: up to 3 jobs to decide (one per employer), drafts to approve, applications to submit, health line |
| On your tap | Apply starts the application workflow; Skip asks for a reason; Snooze brings it back in 3 days |
| 06:30 daily | Check Gmail threads for replies; draft one follow-up after 5 days |
| 20:30 | Nudge only if a Today item has waited 2+ days |
| Sunday 09:00 | Weekly review: funnel, skip reasons, 20 filter rejects to sanity-check, spend |

After **Apply**: resume tailored (PDF in Telegram), then a contact search. If a contact is found, you get a draft to Send, Edit or Drop. After sending, it waits 3 days (or until a reply), then queues the application. The laptop agent fills the form and stops before Submit; you click Submit and tap **I submitted it**.

## What's in the repo

```
src/core/        pure logic, no I/O: filters, keys, source parsers, ranker, state machine, judge prompt and bands,
                 contact parsing, outreach rules, brief layout, signing
src/server/      adapters: Postgres repo, collector, judge runner, Telegram bot, Gmail, search, outreach, steps
src/inngest/     durable workflows: daily run, per-application flow, reply watch, nudges, weekly review, re-judge
app/             Next.js: 5 dashboard pages + API routes (Telegram webhook, Inngest, agent, auth, actions)
migrations/      Postgres schema (12 tables + kv, login codes, migrations)
seed/            your sources, judge profile, preferences, caps and past applications
resume-service/  Python (standard library only) LaTeX tailoring service with the one-page gate
agent/           laptop apply-assist (Playwright, your own Chrome profile)
tests/           unit tests + Postgres integration tests (real schema, real SQL)
```

## Setup (about 45 minutes)

1. **Accounts.** Neon (Postgres, free tier), Vercel (Hobby), Inngest (free tier, add the Vercel integration), Anthropic API key, Telegram bot from @BotFather. Optional: Brave Search API key (contact search), Hunter.io (verified emails), Google Cloud OAuth client (Gmail sending), Firecrawl key.
2. **Environment.** Copy `.env.example` to `.env.local` and fill it in. Generate secrets with `openssl rand -hex 32`. Put the same values in Vercel's environment variables.
3. **Database.** `npm install`, then `npm run db:migrate` and `npm run db:seed`.
4. **Deploy.** Import the repo in Vercel and deploy. Connect the Inngest Vercel integration so `/api/inngest` is synced; the cron schedules appear in the Inngest dashboard.
5. **Telegram.** Set `APP_URL` to your Vercel URL and run `npm run telegram:webhook`. Send `/help` to your bot.
6. **Your network.** LinkedIn > Settings > Data privacy > Get a copy of your data > Connections. Send `Connections.csv` to the bot. The weekly review reminds you when it is 30 days old.
7. **Gmail (optional).** Create an OAuth client of type Desktop app, add its id and secret to `.env.local`, run `npm run gmail:auth`, and save the printed `GMAIL_REFRESH_TOKEN` in Vercel. Scopes are `gmail.send` and `gmail.metadata` only.
8. **Resume service (optional).** Copy your `master_resume.md`, `template.tex` (and `verify.py`, `rules.md`) into `resume-service/assets/`. Run it locally (`RESUME_SERVICE_TOKEN=... ANTHROPIC_API_KEY=... python3 resume-service/app.py`) or deploy the Dockerfile to Cloud Run or Fly.io. Set `RESUME_SERVICE_URL` and `RESUME_SERVICE_TOKEN` in Vercel. Without it, applications continue with your base resume.
9. **Laptop agent (optional).** `cd agent && npm install && npx playwright install chromium`, copy `answers.example.json` to `answers.local.json` and fill it in, set `JOBHUNT_URL`, `AGENT_TOKEN`, `CHROME_PROFILE_DIR`, then `npm start`. Sign in to Workday or other ATS accounts once in that Chrome profile.
10. **First run.** `npm run collect:once` runs one full cycle locally and prints what each source returned. Add `-- --brief` to also send the brief.

## Telegram commands

`/today`, `/brief`, `/pipeline`, `/job <company>`, `/prefs`, `/prefs rule <text>`, `/prefs exclude <term>`, `/prefs drop <id>`, `/cap <company> <n>`, `/referral <app id> <link>`, `/submitted <app id>`, `/outcome <app id> interview|offer|rejected`, `/pause`, `/resume`, `/retry <app id>`, `/unlock`, `/health`. Any other text goes to the read-only coach.

The dashboard sign-in sends a 6-digit code to your Telegram chat; there are no passwords. Only the newest code works, each code allows 5 tries, and at most 10 codes are issued a day. If sign-in locks, send `/unlock` to the bot.

## Safety model

- **Telegram:** the webhook checks Telegram's secret header, and the bot answers only messages and taps from you in your own chat. Buttons carry HMAC-signed, expiring payloads, so a forged or stale tap does nothing. Commands you type there (`/submitted`, `/outcome`) count as taps. Each update is handled once, even if Telegram re-sends it.
- **Laptop agent:** its bearer token can only report a form as filled or failed; it cannot send anything or mark an application submitted.
- **Sending:** Gmail goes out only from a signed Send tap, and each draft is claimed before sending, so a double tap sends once. There is a cap of 5 new emails a day and 20 a week, one follow-up, and a do-not-contact list. Bounces add the address to that list automatically. `/pause` stops all outward actions.
- **LinkedIn:** the system never opens LinkedIn. Contacts come from your own export and from search-engine results (titles and snippets). You send LinkedIn notes yourself. LinkedIn's User Agreement (section 8.2) bans bots, scraping and browser plug-ins, so none are used, including Claude in Chrome.
- **Applications:** the agent fills forms in your own browser and never clicks Submit. It skips CAPTCHAs and leaves fields it cannot match.
- **Untrusted text:** job descriptions and email replies are treated as data. The models that read them have no tools that act.
- **Personal files:** your resume files, answer bank and browser profile are gitignored. The master resume is never stored in the database.

## Costs

Hosting, database, Inngest and Telegram fit their free tiers at one person's volume. Claude API usage is the main cost. Estimated at about 2.5 million input tokens a month: judge ~1.8M with the smaller model, resumes and drafts ~0.5M. The token figures are estimates; price them against Anthropic's pricing page. `MONTHLY_INPUT_TOKEN_CAP` stops the judge if usage runs ahead. Brave's monthly credit covers about 1,000 searches.

## Testing

```
npm test                                  # 70 tests; Postgres tests need PGHOST/PGPORT/PGUSER (CI starts one)
cd resume-service && python3 -m unittest  # LaTeX compile, one-page gate, verify.py, auth
cd agent && npm test                      # form filling in headless Chromium
```

## Known limits

- TikTok's careers site is JavaScript-only. Its descriptions arrive only through Firecrawl (Singapore internships, within caps) or the aggregators; otherwise the judge flags "no JD" and caps the score at 64.
- Workday applications are multi-page and need an account per company. The agent fills the first page only; the rest is manual.
- Source endpoints marked UNVERIFIED in `src/core/sources/index.ts` (SmartRecruiters, MyCareersFuture search, freehire.me, and the AppLovin and QRT Greenhouse slugs) need checking on the first run. `/health` lists any that fail.
- The Sheet from v0.3.1 is not synced. Your applied rows (TikTok, JPMorgan) are imported by the seed.
