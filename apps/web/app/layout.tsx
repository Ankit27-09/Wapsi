import type { ReactNode } from 'react';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import { Nav } from './nav';
import './globals.css';

/**
 * Two typefaces, each doing a job the other cannot.
 *
 * Plus Jakarta Sans for everything a person reads: geometric, tight, and heavy enough at 800
 * to carry a headline without looking inflated. JetBrains Mono for every figure, because this
 * console is mostly columns of rupees and a proportional font lets digits drift out of
 * alignment — `1` narrower than `8` is invisible on one row and unreadable down forty.
 *
 * Loaded through `next/font`, which downloads at BUILD time and self-hosts the result. So the
 * running app makes no network call for fonts, there is no flash of unstyled text, and the
 * layout does not shift once they land. The fonts are cached after the first build, so a
 * later build works with no network at all.
 */

const display = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata = {
  title: 'Wapsi — the return',
  description:
    'वापसी — expected-value gated revenue recovery across five risk classes. Razorpay AI ' +
    'Buildathon 2026, Track 03',
};

/**
 * Every page reads live rows from Postgres, so nothing here is cacheable. Declaring it once
 * on the layout beats scattering `export const dynamic` across every route and forgetting
 * one — a stale page in an operations console is worse than a slow one.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      {/*
       * `suppressHydrationWarning` here is about BROWSER EXTENSIONS, not about anything this
       * app renders.
       *
       * Extensions write their own attributes onto `<body>` before React hydrates — ColorZilla
       * adds `cz-shortcut-listen="true"`, and password managers, Grammarly and dark-mode
       * injectors all do the equivalent. React then compares the server's HTML against a DOM
       * that a third party has already edited, finds an attribute it did not emit, and logs a
       * hydration error against our markup for something we did not do.
       *
       * Scoped deliberately to this one element. The flag suppresses mismatches on the element
       * it is set on and its text children, and does NOT extend down the tree, so a genuine
       * hydration bug anywhere inside `<main>` still reports normally. Putting it on `<html>`
       * or on a wrapper around `children` would silence real defects, which is the failure
       * mode worth avoiding here — an operations console that renders different numbers on the
       * server and the client must say so loudly.
       */}
      <body suppressHydrationWarning>
        <Nav />
        <main className="content">{children}</main>
      </body>
    </html>
  );
}
