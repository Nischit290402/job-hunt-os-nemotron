# Job Hunt OS

One product for the whole job search: it finds roles, scores them, tailors your resume, finds someone to ask for a referral, drafts the ask, waits, pre-fills the application, and hands it to you to submit. You run it from Telegram in about 5 to 10 minutes each morning.

**Every outward action needs your tap.** The system never sends an email, a LinkedIn request or an application on its own.

Design doc: [Job Hunt OS: System Design (HLD v1)](https://claude.ai/artifact/WGNzqqeCndvgkUXVoBdnvy)

## How a day works

| Time (SGT) | What happens |
| --- | --- |
| 05:00 | Collect from every source (ATS APIs, MyCareersFuture, lists, Firecrawl pages), one step per source |
| 05:00+ | Fetch missing job descriptions (MCF, SmartRecruiters and Workday APIs, then HTML, then Firecrawl for Singapore internships) |
| 05:15+ | New jobs queued for judging; the app starts your Claude Code scheduled task, which scores them (score, gates, flags, deadline) |
| 07:45 | Telegram brief: up to 3 jobs to decide (one per employer), drafts to approve, applications to submit, health line |
| On your tap | Apply starts the application workflow; Skip asks for a reason; Snooze brings it back in 3 days |
| 06:30 daily | Check Gmail threads for replies; draft one follow-up after 5 days |
| 20:30 | Nudge only if a Today item has waited 2+ days |
| Sunday 09:00 | Weekly review: funnel, skip reasons, 20 filter rejects to sanity-check, spend |

After **Apply**: the scheduled task tailors your resume with your bases and gates (PDF in Telegram within minutes), then a contact search. If a contact is found, you get a draft to Send, Edit or Drop. After sending, it waits 3 days (or until a reply), then queues the application. The laptop agent fills the form and stops before Submit; you click Submit and tap **I submitted it**.

## What's in the repo

```
src/core/        pure logic, no I/O: filters, keys, source parsers, ranker, state machine, judge prompt and bands,
                 contact parsing, outreach rules, brief layout, signing
src/server/      adapters: Postgres repo, collector, Claude work queue, Telegram bot, Gmail, search, outreach, steps
src/inngest/     durable workflows: daily run, per-application flow, reply watch, nudges, weekly review, re-judge, worker watch
app/             Next.js: 5 dashboard pages + API routes (Telegram webhook, Inngest, agent, worker, auth, actions)
migrations/      Postgres schema (12 tables + kv, login codes, migrations)
seed/            your sources, judge profile, preferences, caps and past applications
worker/          cli.mjs: the commands the Claude worker runs (claim, answer, kit, build, submit-resume)
.claude/skills/  jobhunt-worker: how the worker judges, tailors (your /tailor-resume rules), drafts and coaches
agent/           laptop apply-assist (Playwright, your own Chrome profile)
tests/           unit tests + Postgres integration tests (real schema, real SQL)
```

## How Claude runs

There is no Claude API key. The app queues each piece of Claude work (judge a job, tailor a resume, draft an ask,
answer a coach question) in Postgres and starts your Claude Code scheduled task with one HTTP call. That run loads the
`jobhunt-worker` skill from this repo, claims tasks with `node worker/cli.mjs`, and posts results back. Usage counts
against your Claude plan, not an API bill. If nothing picks the work up within 10 minutes, the laptop agent runs Claude
Code locally with the same skill. An hourly watch restarts the task when work has waited 30 minutes, and gives up on a
task after 3 attempts so the application moves on with your base resume.

## Setup

Step-by-step instructions with every click and command: [docs/SETUP.md](docs/SETUP.md).

## Telegram commands

`/today`, `/brief`, `/pipeline`, `/job <company>`, `/lead Company | Role | Person | Link` (JD on the next lines), `/jobtypes [intern parttime fulltime]`, `/tailor <app id> [guidance]`, `/prefs`, `/prefs rule <text>`, `/prefs exclude <term>`, `/prefs drop <id>`, `/cap <company> <n>`, `/referral <app id> <link>`, `/submitted <app id>`, `/outcome <app id> interview|offer|rejected`, `/pause`, `/resume`, `/retry <app id>`, `/unlock`, `/health`. Any other text goes to the read-only coach.

The dashboard sign-in sends a 6-digit code to your Telegram chat; there are no passwords. Only the newest code works, each code allows 5 tries, and at most 10 codes are issued a day. If sign-in locks, send `/unlock` to the bot.

## Safety model

- **Telegram:** the webhook checks Telegram's secret header, and the bot answers only messages and taps from you in your own chat. Buttons carry HMAC-signed, expiring payloads, so a forged or stale tap does nothing. Commands you type there (`/submitted`, `/outcome`) count as taps. Each update is handled once, even if Telegram re-sends it.
- **Laptop agent:** its bearer token can only report a form as filled or failed; it cannot send anything or mark an application submitted.
- **Email:** the app never sends email. A signed tap saves the referral ask to your Gmail drafts (scope `gmail.compose`; the code has no send call), and you send it from Gmail. Each draft is claimed first, so a double tap saves once. There is a cap of 5 new emails a day and 20 a week, one follow-up, and a do-not-contact list. Bounces add the address to that list automatically. `/pause` stops all outward actions.
- **LinkedIn:** the system never opens LinkedIn. Contacts come from your own export and from search-engine results (titles and snippets). You send LinkedIn notes yourself. LinkedIn's User Agreement (section 8.2) bans bots, scraping and browser plug-ins, so none are used, including Claude in Chrome.
- **Applications:** the agent fills forms in your own browser and never clicks Submit. It skips CAPTCHAs and leaves fields it cannot match.
- **Untrusted text:** job descriptions and email replies are treated as data. The worker skill forbids following instructions in them, and the worker can only call the app's queue endpoints; on the laptop it may run nothing but `worker/cli.mjs`.
- **Personal files:** your resume files, answer bank and browser profile are gitignored. Your master resume, bases and gate scripts are synced into the database (key-value table) so the cloud worker can tailor; they never enter the repo.

## Costs

Hosting, database, Inngest and Telegram fit their free tiers at one person's volume. Claude work runs on your Claude
plan's usage: about 40 judged jobs a day in one morning run, plus a few minutes per tailored resume. Brave's monthly
credit covers about 1,000 searches.

## Testing

```
npm test                                  # 78 tests; Postgres tests need PGHOST/PGPORT/PGUSER (CI starts one)
cd agent && npm test                      # form filling in headless Chromium
```

## Known limits

- TikTok's careers site is JavaScript-only. Its descriptions arrive only through Firecrawl (Singapore internships, within caps) or the aggregators; otherwise the judge flags "no JD" and caps the score at 64.
- Workday applications are multi-page and need an account per company. The agent fills the first page only; the rest is manual.
- Source endpoints marked UNVERIFIED in `src/core/sources/index.ts` (SmartRecruiters, MyCareersFuture search, freehire.me, and the AppLovin and QRT Greenhouse slugs) need checking on the first run. `/health` lists any that fail.
- The Sheet from v0.3.1 is not synced. Your applied rows (TikTok, JPMorgan) are imported by the seed.
