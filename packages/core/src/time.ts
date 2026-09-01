import { z } from 'zod';

/**
 * Time primitives shared by the bounds checker and the scheduler.
 *
 * The bounds *rules* live in `@rc/policy`; only the timezone arithmetic lives here,
 * because the simulator and the UI need the same conversion and duplicating it would
 * eventually produce two different answers to "is it currently quiet hours".
 */

export const IST = 'Asia/Kolkata';

export interface LocalClock {
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. Present for future weekend rules; not used by current policy. */
  readonly weekday: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Wall-clock time at an instant in a named timezone.
 *
 * Uses `Intl` rather than a date library: the IANA database ships with the runtime, and
 * India has no DST, so the entire problem is one UTC offset that `Intl` already knows.
 * Adding a dependency to learn that would be a dependency to maintain forever.
 */
export function localClock(instant: Date, timeZone: string = IST): LocalClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    hour: Number.parseInt(lookup('hour'), 10),
    minute: Number.parseInt(lookup('minute'), 10),
    weekday: Math.max(0, weekdays.indexOf(lookup('weekday'))),
  };
}

/** Minutes since local midnight, so a window comparison is one integer comparison. */
export function minutesSinceMidnight(clock: LocalClock): number {
  return clock.hour * 60 + clock.minute;
}

export function parseHHMM(value: string): number {
  const match = HHMM.exec(value);
  if (match === null) throw new RangeError(`Expected HH:MM, got ${JSON.stringify(value)}`);
  return Number.parseInt(match[1] ?? '0', 10) * 60 + Number.parseInt(match[2] ?? '0', 10);
}

/**
 * Whether an instant falls inside a local time window.
 *
 * Handles the wrap case, which is the only case that matters in practice: quiet hours
 * run 21:00 → 09:00 and therefore straddle midnight. A naive `start <= t && t < end`
 * returns false for every minute of the night it is meant to protect, which is the kind
 * of bug that sends a payment reminder at 03:00 and turns a recovery system into a
 * complaint.
 */
export function isWithinLocalWindow(
  instant: Date,
  window: { readonly start: string; readonly end: string; readonly tz: string },
): boolean {
  const now = minutesSinceMidnight(localClock(instant, window.tz));
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

export const HHMMSchema = z.string().regex(HHMM, 'Expected HH:MM in 24-hour form');

export const TimeWindowSchema = z.object({
  start: HHMMSchema,
  end: HHMMSchema,
  tz: z.string().default(IST),
});

export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const HOUR_MS = 3_600_000;

export function hoursBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / HOUR_MS;
}

export function addHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + hours * HOUR_MS);
}
