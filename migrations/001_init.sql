-- Job Hunt OS: initial schema. Postgres 15+ (Neon). Run with `npm run db:migrate`.
-- Personal tables carry user_id (single user today, id 1) so the product can serve more people later without a rewrite.

CREATE TABLE IF NOT EXISTS companies (
  id            serial PRIMARY KEY,
  key           text NOT NULL UNIQUE,          -- normCompany(): 'bytedance' for TikTok and ByteDance
  name          text NOT NULL,
  tier          text,
  employer_cap  int,                           -- e.g. 2 for TikTok's 2027-start project; NULL = no cap
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id               text PRIMARY KEY,
  type             text NOT NULL CHECK (type IN ('greenhouse','lever','ashby','smartrecruiters','mcf','freehire','mdlist','crawl')),
  company          text NOT NULL,
  slug_or_url      text NOT NULL,
  link_pattern     text,
  default_location text,
  track_hint       text,
  tier             text,
  enabled          boolean NOT NULL DEFAULT true,
  notes            text,
  last_status      text,
  last_count       int,
  last_ok_at       timestamptz,
  zero_runs        int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id             serial PRIMARY KEY,
  canonical_key  text NOT NULL UNIQUE,
  xkey           text NOT NULL,
  company_id     int REFERENCES companies(id),
  company        text NOT NULL,
  title          text NOT NULL,
  location       text NOT NULL DEFAULT '',
  url            text NOT NULL,
  channel        text NOT NULL,
  also_seen      text[] NOT NULL DEFAULT '{}',
  track          text NOT NULL CHECK (track IN ('sg','remote','ft','archive')),
  family         text NOT NULL DEFAULT 'ml',
  start_window   text NOT NULL DEFAULT '',
  hours_flag     text NOT NULL DEFAULT '',
  elig_flag      text NOT NULL DEFAULT '',
  posted         date,
  jd_text        text NOT NULL DEFAULT '',
  jd_hash        text,
  jd_status      text NOT NULL DEFAULT 'pending' CHECK (jd_status IN ('ok','pending','unavailable')),
  detail_ref     text,
  source_id      text REFERENCES sources(id),
  first_seen     date NOT NULL,
  last_seen      date NOT NULL,
  missed_runs    int NOT NULL DEFAULT 0,
  closed_at      date
);
CREATE INDEX IF NOT EXISTS jobs_xkey_idx ON jobs (xkey);
CREATE INDEX IF NOT EXISTS jobs_open_idx ON jobs (closed_at) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS judgments (
  id              serial PRIMARY KEY,
  user_id         int NOT NULL DEFAULT 1,
  job_id          int NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  jd_hash         text,
  score           int NOT NULL CHECK (score BETWEEN 0 AND 100),
  verdict         text NOT NULL CHECK (verdict IN ('Apply now','Apply this week','Watch','Skip')),
  gates           jsonb NOT NULL DEFAULT '{}',
  flags           text[] NOT NULL DEFAULT '{}',
  notes           text NOT NULL DEFAULT '',
  deadline        text NOT NULL DEFAULT '',
  rubric_version  text NOT NULL,
  model           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS judgments_job_idx ON judgments (job_id, created_at DESC);

CREATE OR REPLACE VIEW latest_judgments AS
  SELECT DISTINCT ON (job_id) * FROM judgments ORDER BY job_id, created_at DESC;

CREATE TABLE IF NOT EXISTS contacts (
  id               serial PRIMARY KEY,
  user_id          int NOT NULL DEFAULT 1,
  company_id       int REFERENCES companies(id),
  company          text NOT NULL,
  name             text NOT NULL,
  headline         text NOT NULL DEFAULT '',
  linkedin_url     text,
  email            text,
  email_source     text,
  email_confidence text,
  relation         text NOT NULL CHECK (relation IN ('connection','alumni','cold')),
  kind             text NOT NULL DEFAULT 'engineer' CHECK (kind IN ('engineer','recruiter')),
  source           text NOT NULL CHECK (source IN ('connections','xray','manual','public_page')),
  snippet          text,
  found_on         date NOT NULL,
  last_contacted   date,
  do_not_contact   boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_url_uidx ON contacts (user_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts (company_id);

CREATE TABLE IF NOT EXISTS applications (
  id                 serial PRIMARY KEY,
  user_id            int NOT NULL DEFAULT 1,
  job_id             int NOT NULL REFERENCES jobs(id),
  state              text NOT NULL,
  skip_reason        text,
  snooze_until       date,
  snooze_count       int NOT NULL DEFAULT 0,
  picked_on          date NOT NULL,
  decided_at         timestamptz,
  contact_id         int REFERENCES contacts(id),
  referral_url       text,
  applied_at         date,
  outcome            text,
  notes              text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS applications_state_idx ON applications (user_id, state);

CREATE TABLE IF NOT EXISTS resume_versions (
  id              serial PRIMARY KEY,
  user_id         int NOT NULL DEFAULT 1,
  application_id  int NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  tex             text,
  pdf             bytea,                      -- about 100 KB each; kept in Postgres to avoid a separate blob store
  summary         text NOT NULL DEFAULT '',
  verify_passed   boolean,
  verify_output   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                serial PRIMARY KEY,
  user_id           int NOT NULL DEFAULT 1,
  application_id    int NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  contact_id        int NOT NULL REFERENCES contacts(id),
  kind              text NOT NULL DEFAULT 'ask' CHECK (kind IN ('ask','followup')),
  subject           text NOT NULL DEFAULT '',
  body              text NOT NULL DEFAULT '',
  linkedin_note     text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','replied','dropped')),
  channel           text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','linkedin')),
  sent_at           timestamptz,
  gmail_message_id  text,
  gmail_thread_id   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  entity     text NOT NULL,
  entity_id  bigint,
  action     text NOT NULL,
  actor      text NOT NULL CHECK (actor IN ('system','you')),
  payload    jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_entity_idx ON events (entity, entity_id, at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id          bigserial PRIMARY KEY,
  step        text NOT NULL,
  source_id   text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  seconds     numeric,
  ok          boolean NOT NULL,
  error       text,
  detail      jsonb NOT NULL DEFAULT '{}',
  tokens_in   int NOT NULL DEFAULT 0,
  tokens_out  int NOT NULL DEFAULT 0,
  credits     int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS preferences (
  id          serial PRIMARY KEY,
  user_id     int NOT NULL DEFAULT 1,
  kind        text NOT NULL CHECK (kind IN ('rule','exclude_term','archive_term','skip_feedback')),
  text        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  source      text NOT NULL DEFAULT 'you',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile (
  user_id        int PRIMARY KEY DEFAULT 1,
  body           text NOT NULL,                -- what the judge reads (seed/profile.md)
  outreach_summary text NOT NULL DEFAULT '',   -- the short fact list the outreach drafts may use
  weekly_target  int NOT NULL DEFAULT 5,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_codes (
  code_hash   text PRIMARY KEY,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
