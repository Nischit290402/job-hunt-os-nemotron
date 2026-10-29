-- Official apply routes for jobs found on MyCareersFuture or aggregators, and the worker task for form answers.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS apply_url text;          -- the employer's own posting, when found
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS apply_route text CHECK (apply_route IN ('official','email','none'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS apply_email text;        -- "email your CV to ..." address
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS route_checked_at timestamptz;

ALTER TABLE worker_tasks DROP CONSTRAINT IF EXISTS worker_tasks_kind_check;
ALTER TABLE worker_tasks ADD CONSTRAINT worker_tasks_kind_check CHECK (kind IN ('judge','tailor','draft','coach','answers'));
