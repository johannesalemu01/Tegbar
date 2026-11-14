import { describe, expect, it } from 'vitest';
import { describeRecurrence, firstOnOrAfter, nextOccurrence, parseRecurrence, withAnchor, type Recurrence } from '../src/modules/tasks/recurrence.js';

const next = (r: Recurrence, from: string, n = 4) => {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < n; i++) out.push((cur = nextOccurrence(r, cur)));
  return out;
};

describe('recurrence', () => {
  it('daily and every N days', () => {
    expect(next({ freq: 'daily', interval: 1, anchor: '2026-11-15' }, '2026-11-15', 3)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
    expect(next({ freq: 'daily', interval: 3, anchor: '2026-11-15' }, '2026-11-15', 3)).toEqual(['2026-11-18', '2026-11-21', '2026-11-24']);
    // phase is kept from the anchor even when starting later
    expect(nextOccurrence({ freq: 'daily', interval: 3, anchor: '2026-11-15' }, '2026-11-19')).toBe('2026-11-21');
  });

  it('weekly on days, and every 2 weeks', () => {
    const monThu: Recurrence = { freq: 'weekly', interval: 1, weekdays: [1, 4], anchor: '2026-11-16' };
    expect(next(monThu, '2026-11-16')).toEqual(['2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30']);
    const biweekly: Recurrence = { freq: 'weekly', interval: 2, weekdays: [5], anchor: '2026-11-20' };
    expect(next(biweekly, '2026-11-20', 3)).toEqual(['2026-12-04', '2026-12-18', '2027-01-01']);
  });

  it('monthly clamps to short months and supports the last day', () => {
    const on31: Recurrence = { freq: 'monthly', interval: 1, day: 31, anchor: '2026-12-31' };
    expect(next(on31, '2026-12-31', 3)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    const last: Recurrence = { freq: 'monthly', interval: 1, day: 'last', anchor: '2027-01-31' };
    expect(next(last, '2027-01-31', 2)).toEqual(['2027-02-28', '2027-03-31']);
    const leap: Recurrence = { freq: 'monthly', interval: 12, day: 29, anchor: '2028-02-29' };
    expect(nextOccurrence(leap, '2028-02-29')).toBe('2029-02-28');
    const quarterly: Recurrence = { freq: 'monthly', interval: 3, day: 15, anchor: '2026-11-15' };
    expect(next(quarterly, '2026-11-15', 2)).toEqual(['2027-02-15', '2027-05-15']);
  });

  it('first occurrence on or after a date', () => {
    expect(firstOnOrAfter({ freq: 'weekly', interval: 1, weekdays: [1], anchor: '2026-11-15' }, '2026-11-15')).toBe('2026-11-16');
    expect(firstOnOrAfter({ freq: 'daily', interval: 1, anchor: '2026-11-15' }, '2026-11-15')).toBe('2026-11-15');
  });

  it('parses phrases', () => {
    const p = (s: string, wd = 7) => parseRecurrence(s, wd)?.rule;
    expect(p('standup every weekday')).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
    expect(p('pay rent monthly on the 1st')).toEqual({ freq: 'monthly', interval: 1, day: 1 });
    expect(p('close books monthly on the last day')).toEqual({ freq: 'monthly', interval: 1, day: 'last' });
    expect(p('backup every 3 days')).toEqual({ freq: 'daily', interval: 3 });
    expect(p('water plants daily')).toEqual({ freq: 'daily', interval: 1 });
    expect(p('sync every monday and thursday')).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 4] });
    expect(p('review every 2 weeks on fri')).toEqual({ freq: 'weekly', interval: 2, weekdays: [5] });
    expect(p('report weekly', 3)).toEqual({ freq: 'weekly', interval: 1, weekdays: [3] });
    expect(p('invoice every month')).toEqual({ freq: 'monthly', interval: 1, day: 0 });
    expect(p('call mom tomorrow')).toBeUndefined();
    expect(parseRecurrence('sync every mon, thu please', 1)?.match).toBe('every mon, thu');
  });

  it('describes rules', () => {
    expect(describeRecurrence({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })).toBe('Every weekday');
    expect(describeRecurrence({ freq: 'weekly', interval: 2, weekdays: [5] })).toBe('Every 2 weeks on Fri');
    expect(describeRecurrence(withAnchor({ freq: 'monthly', interval: 1, day: 0 }, '2026-11-22'))).toBe('Monthly on the 22nd');
    expect(describeRecurrence({ freq: 'monthly', interval: 1, day: 'last' })).toBe('Monthly on the last day');
  });
});
