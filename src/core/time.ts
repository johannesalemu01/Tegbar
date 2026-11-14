import { DateTime } from 'luxon';

/**
 * Time rules:
 *  - The database stores instants as ISO-8601 UTC strings (toDb/fromDb).
 *  - Local calendar dates (e.g. a date-only due date) are stored as 'YYYY-MM-DD'
 *    in the workspace zone.
 *  - Everything shown to a human goes through the formatters below, which always
 *    convert to the workspace zone first. Never call toISO()/toFormat() on a UTC
 *    DateTime for display.
 */
export const DEFAULT_ZONE = 'Africa/Addis_Ababa';

let zone = DEFAULT_ZONE;
export function setZone(z: string): void {
  if (!DateTime.now().setZone(z).isValid) throw new Error(`Unknown time zone: ${z}`);
  zone = z;
}
export function getZone(): string {
  return zone;
}

export interface Clock {
  now(): DateTime;
}
export const systemClock: Clock = { now: () => DateTime.now().setZone(zone) };
export function fixedClock(iso: string): Clock & { set(iso: string): void; advance(ms: number): void } {
  let current = DateTime.fromISO(iso, { setZone: true }).setZone(zone);
  return {
    now: () => current.setZone(zone),
    set: (v: string) => {
      current = DateTime.fromISO(v, { setZone: true }).setZone(zone);
    },
    advance: (ms: number) => {
      current = current.plus({ milliseconds: ms });
    },
  };
}

export function toDb(dt: DateTime): string {
  const iso = dt.toUTC().toISO();
  if (!iso) throw new Error('Invalid DateTime');
  return iso;
}
export function fromDb(s: string): DateTime {
  return DateTime.fromISO(s, { zone: 'utc' }).setZone(zone);
}
export function local(dt: DateTime): DateTime {
  return dt.setZone(zone);
}
export function localDate(dt: DateTime): string {
  return dt.setZone(zone).toFormat('yyyy-MM-dd');
}
export function fromLocalDate(date: string): DateTime {
  return DateTime.fromISO(date, { zone });
}
/** Build an instant from local wall-clock parts in the workspace zone. */
export function atLocal(date: string, hour: number, minute: number): DateTime {
  return DateTime.fromISO(date, { zone }).set({ hour, minute, second: 0, millisecond: 0 });
}

export type TimeFormat = '24h' | '12h';

export function fmtTime(dt: DateTime, f: TimeFormat = '24h'): string {
  return dt.setZone(zone).toFormat(f === '24h' ? 'HH:mm' : 'h:mm a');
}

/**
 * Human date relative to `now`: "Today", "Tomorrow", "Yesterday", weekday for
 * the next 6 days, otherwise "Fri 20 Nov" (+ year if not this year).
 */
export function fmtDay(date: string, now: DateTime): string {
  const d = fromLocalDate(date);
  const today = now.setZone(zone).startOf('day');
  const diff = Math.round(d.startOf('day').diff(today, 'days').days);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toFormat('cccc');
  return d.year === today.year ? d.toFormat('ccc d LLL') : d.toFormat('ccc d LLL yyyy');
}

export function fmtDateTime(dt: DateTime, now: DateTime, f: TimeFormat = '24h'): string {
  const l = dt.setZone(zone);
  return `${fmtDay(l.toFormat('yyyy-MM-dd'), now)}, ${fmtTime(l, f)}`;
}

/** Short absolute stamp for history lines: "15 Nov 10:02". */
export function fmtStamp(dt: DateTime, f: TimeFormat = '24h'): string {
  return `${dt.setZone(zone).toFormat('d LLL')} ${fmtTime(dt, f)}`;
}
