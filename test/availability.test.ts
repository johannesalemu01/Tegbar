import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { blockedUntil, inQuietHours, type AvailabilityPrefs } from '../src/core/services/availability.js';
import { toDb } from '../src/core/time.js';

const Z = 'Africa/Addis_Ababa';
const at = (s: string) => DateTime.fromISO(s, { zone: Z });
const base: AvailabilityPrefs = { quietEnabled: true, quietStart: '22:00', quietEnd: '07:00', focusUntil: null, dndUntil: null };
const iso = (dt: DateTime | null) => dt?.setZone(Z).toFormat("yyyy-MM-dd'T'HH:mm") ?? null;

describe('availability', () => {
  it('quiet hours across midnight', () => {
    expect(inQuietHours(base, at('2026-11-15T23:30'))).toBe(true);
    expect(inQuietHours(base, at('2026-11-16T06:59'))).toBe(true);
    expect(inQuietHours(base, at('2026-11-16T07:00'))).toBe(false);
    expect(inQuietHours(base, at('2026-11-15T21:59'))).toBe(false);
    expect(inQuietHours({ ...base, quietEnabled: false }, at('2026-11-15T23:30'))).toBe(false);
    expect(inQuietHours({ ...base, quietStart: '13:00', quietEnd: '14:00' }, at('2026-11-15T13:30'))).toBe(true);
  });

  it('holds direct and nudge in quiet hours until they end; urgent goes through', () => {
    const now = at('2026-11-15T23:30');
    expect(iso(blockedUntil(base, 'nudge', now))).toBe('2026-11-16T07:00');
    expect(iso(blockedUntil(base, 'direct', now))).toBe('2026-11-16T07:00');
    expect(blockedUntil(base, 'urgent', now)).toBeNull();
    expect(blockedUntil(base, 'nudge', at('2026-11-15T12:00'))).toBeNull();
  });

  it('focus holds nudges only; DND holds direct too', () => {
    const now = at('2026-11-15T12:00');
    const focus = { ...base, focusUntil: toDb(at('2026-11-15T14:00')) };
    expect(iso(blockedUntil(focus, 'nudge', now))).toBe('2026-11-15T14:00');
    expect(blockedUntil(focus, 'direct', now)).toBeNull();
    const dnd = { ...base, dndUntil: toDb(at('2026-11-15T13:00')) };
    expect(iso(blockedUntil(dnd, 'direct', now))).toBe('2026-11-15T13:00');
    expect(blockedUntil(dnd, 'urgent', now)).toBeNull();
  });

  it('chains blocks: focus ending inside quiet hours waits for the morning', () => {
    const p = { ...base, focusUntil: toDb(at('2026-11-15T23:00')) };
    expect(iso(blockedUntil(p, 'nudge', at('2026-11-15T20:00')))).toBe('2026-11-16T07:00');
  });

  it('expired focus/DND does nothing', () => {
    const p = { ...base, focusUntil: toDb(at('2026-11-15T09:00')), dndUntil: toDb(at('2026-11-15T09:00')) };
    expect(blockedUntil(p, 'nudge', at('2026-11-15T12:00'))).toBeNull();
  });
});
