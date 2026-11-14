import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildIcs, escapeText, fold } from '../src/modules/meetings/ics.js';
import { horizonWeeks, normalizeMeetLink, rotationHost, slotDate, weekStartOf } from '../src/modules/meetings/schedule.js';

describe('meeting schedule helpers', () => {
  it('week keys and slot dates', () => {
    expect(weekStartOf('2026-11-15')).toBe('2026-11-09'); // Sunday → previous Monday
    expect(weekStartOf('2026-11-16')).toBe('2026-11-16');
    expect(slotDate('2026-11-16', 2)).toBe('2026-11-17');
    expect(slotDate('2026-11-16', 6)).toBe('2026-11-21');
    expect(horizonWeeks('2026-11-15', 3)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23']);
  });

  it('hosts alternate weekly and between the two slots', () => {
    const ids = [1, 2];
    const w1 = '2026-11-16';
    const w2 = '2026-11-23';
    expect([rotationHost(w1, 0, ids), rotationHost(w1, 1, ids)].sort()).toEqual([1, 2]);
    expect(rotationHost(w2, 0, ids)).toBe(rotationHost(w1, 1, ids));
    expect(rotationHost(w1, 0, [7])).toBe(7);
    expect(rotationHost(w1, 0, [])).toBeNull();
  });

  it('validates Google Meet links', () => {
    expect(normalizeMeetLink('meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(normalizeMeetLink(' https://meet.google.com/ABC-DEFG-HIJ?authuser=0 ')).toBe('https://meet.google.com/abc-defg-hij');
    expect(normalizeMeetLink('https://zoom.us/j/123')).toBeNull();
    expect(normalizeMeetLink('https://meet.google.com/abc-defg')).toBeNull();
    expect(normalizeMeetLink('https://evil.com/meet.google.com/abc-defg-hij')).toBeNull();
  });
});

describe('ics writer', () => {
  const now = DateTime.fromISO('2026-11-15T07:00:00Z');
  const start = DateTime.fromISO('2026-11-17T19:00', { zone: 'Africa/Addis_Ababa' });

  it('writes UTC times, CRLF, escaping and alarms', () => {
    const ics = buildIcs([{
      uid: 'meeting-7@tegbar', sequence: 2, start, end: start.plus({ minutes: 60 }), summary: 'Weekly sync; RideHome, General',
      location: 'The Spot, Kazanchis', url: 'https://meet.google.com/abc-defg-hij', alarms: [10],
    }], now);
    expect(ics).toContain('DTSTART:20261117T160000Z\r\n');
    expect(ics).toContain('DTEND:20261117T170000Z\r\n');
    expect(ics).toContain('SUMMARY:Weekly sync\; RideHome\\, General\r\n');
    expect(ics).toContain('TRIGGER:-PT10M');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it('folds long UTF-8 (Amharic) lines without breaking characters', () => {
    const long = `SUMMARY:${'ስብሰባ '.repeat(30)}`;
    const folded = fold(long);
    for (const l of folded.split('\r\n')) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(escapeText('a\nb')).toBe('a\\nb');
  });

  it('marks cancelled events', () => {
    const ics = buildIcs([{ uid: 'x', sequence: 1, start, end: start.plus({ hours: 1 }), summary: 's', cancelled: true, alarms: [10] }], now);
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).not.toContain('VALARM');
  });
});
