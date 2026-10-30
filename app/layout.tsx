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
          <a className="brand" href="/chat" aria-label="Job Hunt OS, assistant">
            <span className="brand-mark" aria-hidden>
              <svg viewBox="0 0 20 20">
                <rect x="3" y="6.5" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="M7.5 6.5V5a1.5 1.5 0 011.5-1.5h2A1.5 1.5 0 0112.5 5v1.5M3 11h14" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            </span>
            <span>Job Hunt OS</span>
          </a>
          <nav className="nav-pills" data-tour="nav" aria-label="Main">
            <a href="/chat">Assistant</a>
            <a href="/">Today</a>
            <a href="/pipeline">Pipeline</a>
            <a href="/companies">Companies</a>
            <a href="/memory" data-tour="memory-link">
              Memory
            </a>
            {!demo && <a href="/people">People</a>}
            {!demo && <a href="/settings">Settings and health</a>}
          </nav>
          {demo && <span className="pill accent demo-pill">Demo</span>}
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="signout">
              Sign out
            </button>
          </form>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
