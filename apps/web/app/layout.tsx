import type { ReactNode } from 'react';
import { Nav } from './nav';
import './globals.css';

export const metadata = {
  title: 'Recovery Controller',
  description: 'Expected-value gated payment recovery — operations console',
};

/**
 * Every page reads live rows from Postgres, so nothing here is cacheable. Declaring it once
 * on the layout beats scattering `export const dynamic` across every route and forgetting
 * one — a stale page in an operations console is worse than a slow one.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav />
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
