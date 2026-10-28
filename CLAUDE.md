# Job Hunt OS: notes for Claude

- Personal job-search automation for Nischit Hosamani. Telegram is the main interface; the dashboard is secondary.
- Hard rule: nothing outward (email, LinkedIn, application submit) happens without a signed user tap. Never add automated LinkedIn access of any kind (User Agreement 8.2). Firecrawl is for job search only.
- Logic lives in `src/core` (pure, unit-tested). I/O lives in `src/server`. Only `repo.applyEvent` changes `applications.state`, through `core/state.transition`.
- SQL conventions (see `src/server/sql.ts`): select dates as `::text`, JSON in as `JSON.stringify(...)::jsonb`, bytea as base64.
- Claude work goes through the worker queue (`src/server/worker.ts`, `worker/cli.mjs`, `.claude/skills/jobhunt-worker`). Never add a Claude API call.
- Tests: `npm test` (Postgres integration tests need PGHOST/PGPORT/PGUSER), `agent`: `npm test`.
- Writing style for anything user-facing: plain, direct, no em dashes, no emojis.
