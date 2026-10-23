import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Job Hunt OS', description: 'Your daily job search, decided in Telegram.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <span className="brand">Job Hunt OS</span>
          <nav>
            <a href="/">Today</a>
            <a href="/pipeline">Pipeline</a>
            <a href="/people">People</a>
            <a href="/settings">Settings and health</a>
          </nav>
          <form action="/api/auth/logout" method="post">
            <button type="submit">Sign out</button>
          </form>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
