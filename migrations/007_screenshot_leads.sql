-- Screenshot leads: the worker reads screenshots you send in Telegram and turns them into a /lead.
ALTER TABLE worker_tasks DROP CONSTRAINT IF EXISTS worker_tasks_kind_check;
ALTER TABLE worker_tasks ADD CONSTRAINT worker_tasks_kind_check CHECK (kind IN ('judge','tailor','draft','coach','answers','lead'));
