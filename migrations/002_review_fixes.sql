-- Follow-up emails thread under the original: keep the Message-ID they reply to.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to text;
