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

/**
 * The next instant at or after `instant` that falls OUTSIDE a local window.
 *
 * WHY THIS EXISTS, because it is the difference between a system that recovers money and one
 * that merely refuses to misbehave.
 *
 * Quiet hours must never be violated. But there are two ways to honour them, and they are
 * not equivalent. For a RETRY, suppressing the message and letting the charge proceed
 * silently is right — the customer is not involved. For an action whose entire mechanism IS
 * the message — a payment link, a pre-debit notice, a re-authorisation request — cancelling
 * it does not protect the customer from anything. It just abandons the recovery, because a
 * link that was going to arrive at 03:00 was always going to be read at 09:00.
 *
 * So a message-only action is DEFERRED to the edge of the window rather than dropped.
 * Measured: cancelling instead of deferring cost the four messaging classes most of their
 * recoverable value, because attempt landings are spread uniformly across the clock and
 * quiet hours are half of it.
 *
 * Returns `instant` unchanged when it is already outside the window.
 */
export function deferPastLocalWindow(
  instant: Date,
  window: { readonly start: string; readonly end: string; readonly tz: string },
): Date {
  if (!isWithinLocalWindow(instant, window)) return instant;

  const nowMinutes = minutesSinceMidnight(localClock(instant, window.tz));
  const end = parseHHMM(window.end);

  // Minutes to wait until the window's end, wrapping across midnight when the window does.
  const wait = end > nowMinutes ? end - nowMinutes : 1440 - nowMinutes + end;

  // Truncated to the minute first, so the result lands exactly on the boundary rather than
  // carrying the original instant's seconds past it — which would leave a send one second
  // inside a window it was deferred out of, and the bound would block it again.
  const truncated = instant.getTime() - (instant.getTime() % 60_000);
  return new Date(truncated + wait * 60_000);
}

/**
 * The next instant at or after `instant` that falls INSIDE a local window.
 *
 * The mirror of the above, for a window that PERMITS rather than forbids: outbound calling
 * is allowed only between 10:00 and 19:00, so a call scheduled for 21:00 waits for morning
 * instead of being abandoned.
 */
export function deferIntoLocalWindow(
  instant: Date,
  window: { readonly start: string; readonly end: string; readonly tz: string },
): Date {
  if (isWithinLocalWindow(instant, window)) return instant;

  const nowMinutes = minutesSinceMidnight(localClock(instant, window.tz));
  const start = parseHHMM(window.start);

  const wait = start > nowMinutes ? start - nowMinutes : 1440 - nowMinutes + start;
  const truncated = instant.getTime() - (instant.getTime() % 60_000);
  return new Date(truncated + wait * 60_000);
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
