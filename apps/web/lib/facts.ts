import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The three facts the landing page quotes about the PROJECT rather than about a run.
 *
 * WHY THIS FILE EXISTS. Every result figure on that page is read from Postgres, and the page
 * says so about itself. Three counters at the bottom were the exception — typed in by hand —
 * and one of them rotted immediately: it claimed 101 tests when the suite had reached 172.
 * A page that promises it hardcodes nothing, and then hardcodes a number that is wrong, is
 * worse than one that promises nothing, because it invites a reader to check.
 *
 * So these are read from disk per request too. The test count comes from the JSON report
 * `pnpm test` writes, which is the actual reporter output rather than a count of `it(` calls
 * in the source — those disagree, because one `it.each` with six rows is six tests.
 *
 * Everything here degrades to null rather than throwing or guessing. A missing artifact means
 * the tile is not rendered; it never means a stale number is shown as a current one.
 */

/** Repo root, from `apps/web`. `process.cwd()` is the Next app directory in dev and build. */
const ROOT = join(process.cwd(), '..', '..');

export interface ProjectFacts {
  /** Test cases the suite last reported, or null if `pnpm test` has not run. */
  readonly tests: number | null;
  /** Whether every one of them passed, so a red suite cannot be quoted as a green one. */
  readonly testsAllPassed: boolean;
  /** Numbered entries in FAILURES.md. */
  readonly bugs: number | null;
}

/** Shape of the vitest JSON report, narrowed to the two fields used. */
function readTestReport(raw: string): { total: number; failed: number } | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const total = record['numTotalTests'];
  const failed = record['numFailedTests'];

  if (typeof total !== 'number' || typeof failed !== 'number') return null;
  return { total, failed };
}

/**
 * Numbered bug entries in FAILURES.md, counted off the heading pattern.
 *
 * Anchored to `## <n>.` specifically, not to any `##`, so the document's own section headings
 * are not counted as bugs — the count is of things that went wrong, and inflating it with
 * prose headings would be the same species of error the file exists to record.
 */
function countBugs(markdown: string): number {
  return markdown.split('\n').filter((line) => /^## \d+\./.test(line)).length;
}

export async function loadProjectFacts(): Promise<ProjectFacts> {
  const [report, failures] = await Promise.all([
    readFile(join(ROOT, 'artifacts', 'tests.json'), 'utf8').catch(() => null),
    readFile(join(ROOT, 'FAILURES.md'), 'utf8').catch(() => null),
  ]);

  let tests: number | null = null;
  let testsAllPassed = false;

  if (report !== null) {
    try {
      const parsed = readTestReport(report);
      if (parsed !== null) {
        tests = parsed.total;
        testsAllPassed = parsed.failed === 0;
      }
    } catch {
      // A truncated report — `pnpm test` killed mid-write — is a missing report, not a crash.
      tests = null;
    }
  }

  return {
    tests,
    testsAllPassed,
    bugs: failures === null ? null : countBugs(failures),
  };
}
