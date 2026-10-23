/** Sign in with a one-time code sent to your Telegram chat. */
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { sent, error } = await searchParams;
  return (
    <div style={{ maxWidth: 380, margin: '60px auto' }}>
      <h1>Sign in</h1>
      {error && <div className="notice">That code is wrong or expired. Ask for a new one.</div>}
      {sent === 'wait' && <div className="notice">A code was sent less than a minute ago. Check Telegram.</div>}
      <form action="/api/auth/request" method="post" style={{ marginBottom: 16 }}>
        <button type="submit" className="primary">
          {sent ? 'Send another code' : 'Send a code to Telegram'}
        </button>
      </form>
      <form action="/api/auth/verify" method="post" className="row">
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" placeholder="6-digit code" required />
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
