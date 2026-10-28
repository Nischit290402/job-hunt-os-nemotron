/** Public privacy policy, required by Google for the Gmail OAuth app. No sign-in needed. */
export const metadata = { title: 'Privacy policy - Job Hunt OS' };

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 720, margin: '40px auto', lineHeight: 1.6 }}>
      <h1>Job Hunt OS: privacy policy</h1>
      <p>Last updated 29 October 2026 (drafts only).</p>
      <p>
        Job Hunt OS is a personal tool used by one person, Nischit Hosamani, to manage his own job search. It has no other
        users and no sign-up.
      </p>
      <h2>Google user data</h2>
      <ul>
        <li>
          <b>gmail.compose</b>: saves referral emails to Nischit&apos;s Gmail drafts after he approves them with an explicit
          tap. The app never sends email; he reviews and sends each draft from Gmail himself.
        </li>
        <li>
          <b>gmail.metadata</b>: reads message headers and labels (not bodies) of those threads, only to notice when a draft
          was sent and to detect a reply or a bounce.
        </li>
      </ul>
      <p>
        Google user data is used only for these two purposes. It is not sold, shared with third parties, used for
        advertising, or used to train AI models. Message headers are not stored beyond the reply status and Gmail
        thread and message IDs of emails this app sent.
      </p>
      <h2>Storage and deletion</h2>
      <p>
        Data is stored in a private Postgres database that only Nischit can access. Access can be revoked at any time at
        myaccount.google.com/permissions, which stops all Gmail access immediately.
      </p>
      <h2>Contact</h2>
      <p>nischitv29@gmail.com</p>
    </div>
  );
}
