import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { fmtDateTime, fmtDay, fromDb, toDb } from '../src/core/time.js';

describe('time handling', () => {
  const now = DateTime.fromISO('2026-11-15T10:00:00+03:00');

  it('stores UTC and displays Africa/Addis_Ababa', () => {
    const at = DateTime.fromISO('2026-11-16T10:00', { zone: 'Africa/Addis_Ababa' });
    expect(toDb(at)).toBe('2026-11-16T07:00:00.000Z');
    expect(fmtDateTime(fromDb('2026-11-16T07:00:00.000Z'), now)).toBe('Tomorrow, 10:00');
    expect(fmtDateTime(fromDb('2026-11-16T07:00:00.000Z'), now, '12h')).toBe('Tomorrow, 10:00 AM');
  });

  it('relative day labels', () => {
    expect(fmtDay('2026-11-15', now)).toBe('Today');
    expect(fmtDay('2026-11-14', now)).toBe('Yesterday');
    expect(fmtDay('2026-11-19', now)).toBe('Thursday');
    expect(fmtDay('2026-11-25', now)).toBe('Wed 25 Nov');
    expect(fmtDay('2027-01-05', now)).toBe('Tue 5 Jan 2027');
  });

  it('a UTC instant near midnight lands on the correct local day', () => {
    // 22:30 UTC on the 15th is 01:30 on the 16th in Addis
    expect(fmtDateTime(fromDb('2026-11-15T22:30:00.000Z'), now)).toBe('Tomorrow, 01:30');
  });
});
