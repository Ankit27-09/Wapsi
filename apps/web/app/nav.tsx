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
 */

const ROUTES = [
  { href: '/', label: 'Overview' },
  { href: '/exceptions', label: 'Exception queue' },
  { href: '/inbox', label: 'Customer inbox' },
  { href: '/audit', label: 'Audit trail' },
  { href: '/policy', label: 'Policy' },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sidebar">
      <div className="brand">
        <h1>Recovery Controller</h1>
        <p>expected-value gated</p>
      </div>
      <div className="nav">
        {ROUTES.map((route) => (
          <Link
            key={route.href}
            href={route.href}
            data-active={pathname === route.href ? 'true' : 'false'}
          >
            {route.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
