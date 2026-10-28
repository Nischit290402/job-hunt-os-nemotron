# Setup

About 90 minutes the first time. Do the steps in order: later ones need values from earlier ones.
Put every value in `.env.local` in your local clone (`E:\Projects\Personal_Projects\job-hunt-OS`). Start by copying
`.env.example` to `.env.local`. Never paste keys into a chat.

## 0. Four random secrets (2 min)

Run this four times in PowerShell and paste each result into `.env.local`:

```
python -c "import secrets; print(secrets.token_hex(32))"
```

| Variable | Used for |
|---|---|
| `SIGNING_SECRET` | signs Telegram buttons and the dashboard session |
| `TELEGRAM_WEBHOOK_SECRET` | proves webhook calls come from Telegram |
| `AGENT_TOKEN` | laptop agent to app |
| `RESUME_SERVICE_TOKEN` | app to resume service |

## 1. Telegram bot (5 min)

1. In Telegram, open `@BotFather` and send `/newbot`.
2. Name: `Job Hunt OS`. Username: anything ending in `bot`, for example `nischit_jobhunt_bot`.
3. Copy the token it returns into `TELEGRAM_BOT_TOKEN`.
4. Open your new bot, press **Start**, and send it `hi`.
5. In a browser open `https://api.telegram.org/bot<TOKEN>/getUpdates` (your token in place of `<TOKEN>`). Find
   `"chat":{"id":123456789` and copy the number into `TELEGRAM_CHAT_ID`.

## 2. Neon Postgres (5 min)

1. Sign up at neon.tech with GitHub. Free plan.
2. Create project: name `job-hunt-os`, region **AWS Asia Pacific 1 (Singapore)**.
3. Dashboard, **Connect**. Turn **Connection pooling** on. Copy the connection string into `DATABASE_URL`.

## 3. Anthropic API (5 min, free on Max 5x)

Max 5x includes USD 100 of API credits a month. This app needs roughly USD 10 to 20 of it.

1. Sign in at platform.claude.com with the same account as your Max plan. Create an organization if it asks.
2. On claude.ai (web browser): **Settings > Billing > API credits**. Link that Console organization and accept the
   terms. You can link only one organization and cannot change it yourself, so pick the one you will build in.
   (New subscribers can claim after 7 days on Max.)
3. In the Console: **Workspaces > Create** `job-hunt-os`, then set its monthly spend limit to USD 30. The app also stops
   at `MONTHLY_INPUT_TOKEN_CAP`.
4. **API Keys > Create key** in the `job-hunt-os` workspace. Copy into `ANTHROPIC_API_KEY`. No payment method needed.

## 4. Vercel (10 min)

1. Sign up at vercel.com with GitHub. Hobby plan.
2. **Add New > Project**. If `job-hunt-OS` is not listed, click **Adjust GitHub App Permissions** and give Vercel that repo.
3. Import it. Framework is detected as Next.js. Open **Environment Variables** and paste the whole `.env.local`
   (Vercel splits it into variables). Leave `APP_URL` as is for now.
4. **Deploy**. Copy the production URL (`https://job-hunt-os-xxxx.vercel.app`) into `APP_URL` in both `.env.local` and
   Vercel (**Settings > Environment Variables**).
5. **Settings > Functions > Function Region**: Singapore (`sin1`), next to the database.
6. **Deployments > ... > Redeploy** so the new `APP_URL` and region apply.

## 5. Inngest (5 min)

1. In Vercel, **Integrations > Browse Marketplace > Inngest > Add Integration**, and connect it to the `job-hunt-os`
   project. It sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel for you.
2. Redeploy once more. In the Inngest dashboard, **Apps** should show `job-hunt-os` with 6 functions
   (`daily-run`, `application-flow`, `reply-watch`, `evening-nudge`, `weekly-review`, `rejudge`).

## 6. Resume service on Google Cloud Run (20 min)

Vercel cannot run LaTeX, so the resume service runs on Cloud Run (it scales to zero, so it costs nothing while idle).
The same Google Cloud project is reused for Gmail in step 7.

1. Install the Google Cloud CLI (cloud.google.com/sdk/docs/install), then in PowerShell:
   ```
   gcloud auth login
   gcloud projects create jobhunt-os-nh --name "Job Hunt OS"
   gcloud config set project jobhunt-os-nh
   ```
   (If the id is taken, pick another and use it below.)
2. console.cloud.google.com > **Billing**: link a billing account to the project (needed for Cloud Run; the free tier
   covers this usage).
3. Enable the APIs:
   ```
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```
4. Copy your resume files into the service and deploy:
   ```
   cd E:\Projects\Personal_Projects\job-hunt-OS\resume-service
   python sync_assets.py
   gcloud run deploy resume-service --source . --region asia-southeast1 --allow-unauthenticated --memory 1Gi --timeout 300 --set-env-vars "RESUME_SERVICE_TOKEN=<value>,ANTHROPIC_API_KEY=<value>,WRITER_MODEL=claude-sonnet-5-5"
   ```
   `--allow-unauthenticated` only means Google does not add its own login; every request still needs your
   `RESUME_SERVICE_TOKEN`.
5. Copy the printed service URL into `RESUME_SERVICE_URL` (in `.env.local` and Vercel). Check it:
   open `<URL>/health`; it should show `"ok": true, "base": true, "gates": true`.
6. Redeploy (step 4 command only) after you change a base or a gate script. Master resume edits need no redeploy:
   the laptop agent syncs them (step 9).

## 7. Gmail sending (15 min, optional; without it you send referral emails yourself)

In the same Google Cloud project:

1. **APIs & Services > Library**: enable **Gmail API**.
2. **Google Auth Platform > Branding**: app name `Job Hunt OS`, support email `nischitv29@gmail.com`.
3. **Audience**: user type External. Add `nischitv29@gmail.com` as a test user. Then click **Publish app**
   (status "In production"). In "Testing" status Google expires the refresh token after 7 days.
4. **Data Access > Add scopes**: `https://www.googleapis.com/auth/gmail.send` and
   `https://www.googleapis.com/auth/gmail.metadata`.
5. **Clients > Create client**, type **Desktop app**. Copy the id and secret into `GMAIL_CLIENT_ID` and
   `GMAIL_CLIENT_SECRET`.
6. In your clone: `npm install`, then `npm run gmail:auth`. Open the printed URL, accept the "Google hasn't verified this
   app" warning (it is your own app), approve, and paste the `code` value from the address bar of the page that fails
   to load. Copy the printed `GMAIL_REFRESH_TOKEN` into `.env.local` and Vercel.

## 8. Optional keys

| Key | Where | Effect if missing |
|---|---|---|
| `BRAVE_SEARCH_API_KEY` | api-dashboard.search.brave.com > Subscriptions (pick the cheapest plan) > API Keys | No X-ray contact search; only your Connections.csv |
| `HUNTER_API_KEY` | hunter.io > API | No verified email lookup; LinkedIn note drafts only |
| `FIRECRAWL_API_KEY` | firecrawl.dev dashboard > API Keys | Google and Optiver career pages and some TikTok JDs are skipped |

Add each to `.env.local` and Vercel, then redeploy.

## 9. First run (Claude can do this part on your laptop)

```
cd E:\Projects\Personal_Projects\job-hunt-OS
git pull
npm install
npm run db:migrate
npm run db:seed
npm run telegram:webhook
npm run collect:once
```

Then the laptop agent, which fills application forms and syncs your master resume:

```
cd agent
npm install
copy answers.example.json answers.local.json   # fill in your answers
npm run sync-master                            # pushes the vault master once
npm start                                      # leave running while you work
```

Set `JOBHUNT_URL` (your Vercel URL) and `AGENT_TOKEN` in `agent\.env` first. In Telegram, `/health` should list
sources, spend and the master resume sync date.
