/** Sign in. Owner setup: a one-time code sent to your Telegram chat. Public demo (DEMO_MODE=1): one shared password. */
export const dynamic = 'force-dynamic';

type Params = { sent?: string; error?: string; e?: string };

function DemoLogin({ e }: { e?: string }) {
  return (
    <div className="login">
      <div className="login-card">
        <h1>Job Hunt OS</h1>
        <p className="muted">A private job-hunt assistant on NVIDIA Nemotron via Nebius Token Factory. Enter the demo password from the submission page.</p>
        {e === '1' && <div className="notice bad">That password is wrong.</div>}
        {e === 'limit' && <div className="notice bad">Too many wrong passwords today. Try again tomorrow (Singapore time).</div>}
        {e === 'off' && <div className="notice bad">The demo password is not set on this deployment.</div>}
        <form action="/api/auth/demo" method="post" className="login-form">
          <label htmlFor="pw" className="small muted">
            Demo password
          </label>
          <input id="pw" name="password" type="password" autoComplete="current-password" required autoFocus />
          <button type="submit" className="primary">
            Open the demo
          </button>
        </form>
        <p className="small muted">Personal details are masked in the demo and nothing is ever sent for you.</p>
      </div>
    </div>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { sent, error, e } = await searchParams;
  if (process.env.DEMO_MODE === '1') return <DemoLogin e={e} />;
  return (
    <div style={{ maxWidth: 380, margin: '60px auto' }}>
      <h1>Sign in</h1>
      {error && <div className="notice">That code is wrong or expired. Ask for a new one.</div>}
      {sent === 'wait' && <div className="notice">A code was sent less than a minute ago. Check Telegram.</div>}
      {sent === 'limit' && <div className="notice">Daily code limit reached. Send /unlock to the bot to reset it.</div>}
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
