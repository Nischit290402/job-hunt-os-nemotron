-- Claude work runs in your Claude Code scheduled task (or Claude Code on your laptop), not through the API.
-- The app queues each piece of work here; the worker claims it, does it, and posts the result back.
CREATE TABLE IF NOT EXISTS worker_tasks (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('judge','tailor','draft','coach')),
  ref         text NOT NULL,                       -- dedupe key, e.g. job:12:abcd or app:7
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','done','failed')),
  attempts    int NOT NULL DEFAULT 0,
  claimed_by  text,
  claimed_at  timestamptz,
  result      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
-- One open task per piece of work.
CREATE UNIQUE INDEX IF NOT EXISTS worker_tasks_open ON worker_tasks (kind, ref) WHERE status IN ('queued','claimed');
CREATE INDEX IF NOT EXISTS worker_tasks_status ON worker_tasks (status, created_at);
