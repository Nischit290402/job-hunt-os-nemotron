# Backlog

Features agreed but not started. Build them after the core loop is complete.

## LinkedIn link intake (requested 2026-10-29): built as /lead

You share a LinkedIn URL in Telegram while scrolling: a job posting, or someone's post that has an apply link or says
"DM me". The app then:

1. Records the opportunity (company, role, apply link or "DM the poster").
2. Tailors a resume for it with the usual worker flow and sends the PDF.
3. Proposes a legitimate contact (the poster when they asked for DMs, else the usual contact search) and drafts the
   message for your approval.

Constraint: the app never fetches LinkedIn pages itself (User Agreement 8.2). Open design question: how the post text
reaches the app. Likely answer: you paste or forward the post text with the link, since the share sheet only carries
the URL.
