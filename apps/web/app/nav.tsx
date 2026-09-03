'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The only client component in the application.
 *
 * It exists solely to highlight the active route, which needs the current pathname. Every
 * other component is a Server Component that queries Postgres directly — no API layer, no
 * fetch, no client state library, and nothing to keep in sync between a route handler and
 * the page that reads it.
 *
 * A TOP bar rather than a sidebar. Seven routes do not need 236 pixels of permanent width, and
 * this console's pages are wide — dense tables of rupees with eight columns. Giving that
 * horizontal space back to the data is worth more than a persistent vertical list, and the
 * landing page in particular reads better full-width.
 */

const ROUTES = [
  { href: '/', label: 'Home' },
  // Detection first among the data pages, because it is first in the loop.
  { href: '/detect', label: 'Detect' },
  { href: '/overview', label: 'Overview' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/audit', label: 'Audit' },
  { href: '/policy', label: 'Policy' },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          {/* A target with a ring through it: the whole product is choosing what to aim at
              and, more often, what to leave alone. Inline SVG rather than an icon font or an
              image — one fewer request, and it inherits the accent colour. */}
          <svg
            className="brand-mark"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="4.25" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <path d="M12 0.5v4M12 19.5v4M0.5 12h4M19.5 12h4" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <span className="brand-name">
            Recovery <span className="brand-accent">Controller</span>
          </span>
        </Link>

        <nav className="topnav">
          {ROUTES.map((route) => (
            <Link
              key={route.href}
              href={route.href}
              data-active={pathname === route.href ? 'true' : 'false'}
            >
              {route.label}
            </Link>
          ))}
        </nav>

        <div className="topbar-tail">
          <span className="pill accent">Track 03</span>
        </div>
      </div>
    </header>
  );
}
