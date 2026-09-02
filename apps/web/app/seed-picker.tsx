import Link from 'next/link';
import { loadSeeds } from '../lib/queries';

/**
 * A switch between the runs actually in the database.
 *
 * WHY THIS IS A FEATURE AND NOT A CONVENIENCE.
 *
 * Every figure in this console is computed from Postgres on each request. But the runs are
 * deterministic by design — same seed, same numbers, always — so a console pinned to one seed
 * looks exactly like a page of typed-in figures. That guarantee is one of the project's
 * stronger claims and it is also what makes the claim hard to believe.
 *
 * One click resolves it. Pick a different seed and every number on the page moves, because
 * every number was read rather than written. That is a demonstration rather than an
 * assurance, which is the standard the rest of the system is held to.
 *
 * A Server Component, like everything else here: it queries the database directly, and the
 * seeds it offers are the ones that exist rather than a list somebody maintained.
 */
export async function SeedPicker({
  current,
  path,
}: {
  readonly current: number;
  /** The route to stay on when switching, so a reader does not lose their place. */
  readonly path: string;
}) {
  const seeds = await loadSeeds();

  // One run is the normal case and needs no chooser — but it does need the label, because
  // "seed 42" beside a figure is what tells a reader the figure came from somewhere.
  if (seeds.length <= 1) {
    return (
      <div className="seedbar">
        <span className="seedbar-label">run</span>
        <span className="pill accent">seed {current}</span>
        <span className="seedbar-note">
          Computed from Postgres on every request. Same seed always gives the same numbers —
          that is a guarantee, not a cached page. Run{' '}
          <code className="mono">pnpm eval --seed 99</code> and a second run appears here to
          switch between.
        </span>
      </div>
    );
  }

  return (
    <div className="seedbar">
      <span className="seedbar-label">run</span>
      {seeds.map((entry) => (
        <Link
          key={entry.seed}
          href={`${path}?seed=${entry.seed}`}
          className="seed-option"
          data-active={entry.seed === current ? 'true' : 'false'}
        >
          seed {entry.seed}
          <span className="dim"> · {entry.transactions} txns</span>
        </Link>
      ))}
      <span className="seedbar-note">
        Switch and every figure changes — each one is read from the database, not written into
        the page.
      </span>
    </div>
  );
}
