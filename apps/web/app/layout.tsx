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
  title: 'Recovery Controller',
  description:
    'Expected-value gated revenue recovery across five risk classes — Razorpay AI ' +
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
      <body>
        <Nav />
        <main className="content">{children}</main>
      </body>
    </html>
  );
}
