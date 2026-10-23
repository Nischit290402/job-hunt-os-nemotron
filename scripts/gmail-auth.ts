/**
 * One-time Gmail consent to get a refresh token with the two narrow scopes (send, metadata).
 * 1. Google Cloud console: create an OAuth client of type "Desktop app"; put its id and secret in .env.local.
 * 2. npm run gmail:auth, open the printed URL, approve, paste the code shown.
 * 3. Save the printed GMAIL_REFRESH_TOKEN in Vercel's environment variables.
 */
import './_env';
import { createInterface } from 'node:readline/promises';
import { GMAIL_SCOPES } from '../src/server/gmail';

const id = process.env.GMAIL_CLIENT_ID;
const secret = process.env.GMAIL_CLIENT_SECRET;
if (!id || !secret) throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first');
const loopback = 'http://127.0.0.1:53682';
const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
auth.search = new URLSearchParams({ client_id: id, redirect_uri: loopback, response_type: 'code', scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent' }).toString();
console.log(`Open this URL, approve, then copy the "code" parameter from the address bar of the page it redirects to (the page itself will not load):\n\n${auth}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question('code: ')).trim();
rl.close();
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: loopback, grant_type: 'authorization_code' }),
});
const data = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
if (!data.refresh_token) throw new Error(`no refresh token: ${data.error} ${data.error_description ?? ''}`);
console.log(`\nGMAIL_REFRESH_TOKEN=${data.refresh_token}`);
