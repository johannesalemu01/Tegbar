import type { DateTime } from 'luxon';

/**
 * Minimal RFC 5545 calendar writer (no dependency). Times are written in UTC
 * ("...Z"), which every calendar converts to the viewer's zone — so
 * Africa/Addis_Ababa needs no VTIMEZONE block. CRLF line endings, text
 * escaping and 75-octet line folding (UTF-8 safe) are handled here.
 */
export interface IcsEvent {
  uid: string;
  sequence: number;
  start: DateTime;
  end: DateTime;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  cancelled?: boolean;
  /** minutes before start */
  alarms?: number[];
}

const stamp = (dt: DateTime) => dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold to ≤75 octets per line without splitting a UTF-8 character. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(events: IcsEvent[], now: DateTime, calendarName = 'Tegbar'): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tegbar//Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `SEQUENCE:${e.sequence}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    for (const m of e.cancelled ? [] : (e.alarms ?? [])) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
