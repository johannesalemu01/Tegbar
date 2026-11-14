import { DateTime } from 'luxon';

/** Pure helpers for meeting schedules (tested). Dates are local 'YYYY-MM-DD'. */

/** Monday of the week containing `date`. Used as the occurrence key of a slot. */
export function weekStartOf(date: string): string {
  return DateTime.fromISO(date, { zone: 'utc' }).startOf('week').toFormat('yyyy-MM-dd');
}

/** The local date of a slot (weekday 1=Mon…7=Sun) in the week starting `weekStart`. */
export function slotDate(weekStart: string, weekday: number): string {
  return DateTime.fromISO(weekStart, { zone: 'utc' }).plus({ days: weekday - 1 }).toFormat('yyyy-MM-dd');
}

/** Week starts for the next `weeks` weeks, beginning with the week of `today`. */
export function horizonWeeks(today: string, weeks: number): string[] {
  const first = DateTime.fromISO(weekStartOf(today), { zone: 'utc' });
  return Array.from({ length: weeks }, (_, i) => first.plus({ weeks: i }).toFormat('yyyy-MM-dd'));
}

const EPOCH = DateTime.fromISO('2024-01-01', { zone: 'utc' }); // a Monday

/**
 * Alternating host. Each week the hosts swap, and slots are offset by
 * `ordinal`, so with two people and two slots each person hosts one meeting
 * a week and alternates between them.
 */
export function rotationHost(weekStart: string, ordinal: number, memberIds: number[]): number | null {
  if (memberIds.length === 0) return null;
  const week = Math.round(DateTime.fromISO(weekStart, { zone: 'utc' }).diff(EPOCH, 'weeks').weeks);
  const idx = (((week + ordinal) % memberIds.length) + memberIds.length) % memberIds.length;
  return memberIds[idx]!;
}

/** Accepts "meet.google.com/abc-defg-hij" (with or without https://, any case). */
export function normalizeMeetLink(input: string): string | null {
  const s = input.trim().replace(/^<|>$/g, '');
  const m = /^(?:https?:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i.exec(s);
  return m ? `https://meet.google.com/${m[1]!.toLowerCase()}` : null;
}

export const shortMeet = (url: string) => url.replace(/^https:\/\//, '');
