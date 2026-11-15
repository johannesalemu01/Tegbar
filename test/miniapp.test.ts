import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shipped to the browser
import * as core from '../public/app/core.js';

const TZ = 'Africa/Addis_Ababa';

describe('Mini App helpers', () => {
  it('formats money from integers', () => {
    expect(core.fmtMoney(150_050, 'ETB')).toBe('1,500.50 ETB');
    expect(core.fmtMoney(-5)).toBe('−0.05 ETB');
    expect(core.fmtMoney(123_456_789, 'ETB', false)).toBe('1,234,567.89');
  });

  it('days and times in Addis Ababa, regardless of the device zone', () => {
    expect(core.dayKey('2026-11-15T22:30:00.000Z', TZ)).toBe('2026-11-16');
    expect(core.fmtTime('2026-11-17T16:00:00.000Z', TZ)).toBe('19:00');
    expect(core.relDay('2026-11-16', '2026-11-15')).toBe('Tomorrow');
    expect(core.relDay('2026-11-20', '2026-11-15')).toBe('Fri 20 Nov');
    expect(core.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(core.weekdayShort('2026-11-15')).toBe('Sun');
  });

  it('overdue and due labels', () => {
    const now = '2026-11-15T07:00:00.000Z'; // 10:00 Addis
    expect(core.isOverdue({ status: 'todo', dueDate: '2026-11-15', dueAt: '2026-11-15T06:00:00.000Z' }, now, TZ)).toBe(true);
    expect(core.isOverdue({ status: 'todo', dueDate: '2026-11-15', dueAt: null }, now, TZ)).toBe(false);
    expect(core.isOverdue({ status: 'done', dueDate: '2026-11-01', dueAt: null }, now, TZ)).toBe(false);
    expect(core.dueLabel({ dueDate: '2026-11-16', dueAt: '2026-11-16T07:00:00.000Z' }, now, TZ)).toBe('Tomorrow, 10:00');
  });

  it('board columns sort by due date then priority', () => {
    const c = core.columns([
      { id: 1, status: 'todo', dueDate: null, priority: 'high' },
      { id: 2, status: 'todo', dueDate: '2026-11-20', priority: 'normal' },
      { id: 3, status: 'todo', dueDate: '2026-11-20', priority: 'high' },
      { id: 4, status: 'done', completedAt: '2026-11-14' },
      { id: 5, status: 'blocked' },
    ]);
    expect(c.todo.map((t: any) => t.id)).toEqual([3, 2, 1]);
    expect(c.blocked).toHaveLength(1);
    expect(c.done).toHaveLength(1);
  });

  it('agenda groups meetings and tasks by local day', () => {
    const days = core.agenda(
      [{ id: 1, startAt: '2026-11-17T16:00:00.000Z', status: 'scheduled' }],
      [{ id: 9, status: 'todo', dueDate: '2026-11-17', dueAt: '2026-11-17T06:00:00.000Z' }, { id: 8, status: 'done', dueDate: '2026-11-17' }],
      TZ, '2026-11-15', 3,
    );
    expect(days.map((d: any) => d.label)).toEqual(['Today', 'Tomorrow', 'Tue 17 Nov']);
    expect(days[2].items.map((x: any) => x.kind)).toEqual(['task', 'meeting']);
  });

  it('chart helpers', () => {
    expect(core.barHeights([0, 50, 100, 1])).toEqual([0, 50, 100, 4]);
    expect(core.shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(core.trendSeries([{ month: '2026-11', currency: 'ETB', amountMinor: 500 }], '2026-11', 'ETB', 3)).toEqual([
      { month: '2026-09', amountMinor: 0 }, { month: '2026-10', amountMinor: 0 }, { month: '2026-11', amountMinor: 500 },
    ]);
    expect(core.balanceLines([{ currency: 'ETB', transfers: [{ from: 2, to: 1, amount: 55_000 }] }], { 1: 'John', 2: 'Sami' }))
      .toEqual([{ text: 'Sami owes John', amount: '550.00 ETB' }]);
  });
});
