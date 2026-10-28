-- Referral emails go to your Gmail drafts, never straight out. 'gmail_draft' = saved in Gmail, waiting for you to send it.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN ('draft','gmail_draft','sent','replied','dropped'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gmail_draft_id text;
