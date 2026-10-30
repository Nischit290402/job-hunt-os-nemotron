import './globals.css';
import type { ReactNode } from 'react';
import { env } from '@/src/server/env';

export const metadata = { title: 'Job Hunt OS', description: 'A private job-hunt assistant on NVIDIA Nemotron via Nebius Token Factory.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  const demo = env.demoMode();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a className="brand" href="/chat">
            Job Hunt OS
          </a>
          <nav>
            <a href="/chat">Assistant</a>
            <a href="/">Today</a>
            <a href="/pipeline">Pipeline</a>
            <a href="/companies">Companies</a>
            <a href="/memory">Memory</a>
            {!demo && <a href="/people">People</a>}
            {!demo && <a href="/settings">Settings and health</a>}
          </nav>
          {demo && <span className="pill accent demo-pill">Demo</span>}
          <form action="/api/auth/logout" method="post">
            <button type="submit">Sign out</button>
          </form>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
