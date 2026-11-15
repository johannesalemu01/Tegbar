import { describe, expect, it } from 'vitest';
import { meetingStreak, priorityCandidates, rebalanceHint, topPriorities, weekOf } from '../src/modules/insights/logic.js';

describe('three priorities', () => {
  const base = { today: '2026-11-20', decisions: [], budgets: [], approvals: [] };
  const task = (o: object) => ({ id: 1, title: 't', status: 'todo' as const, priority: 'normal' as const, dueDate: null, overdue: false, ownerName: 'Sami', ...o });

  it('ranks overdue > budget over > blocked > high due soon ≈ old decision > approval', () => {
    const c = priorityCandidates({
      ...base,
      tasks: [
        task({ id: 1, title: 'Renew domain', dueDate: '2026-11-17', overdue: true }),
        task({ id: 2, title: 'SMS contract', status: 'blocked' }),
        task({ id: 3, title: 'Pitch deck', priority: 'high', dueDate: '2026-11-22' }),
        task({ id: 4, title: 'Someday', priority: 'low', dueDate: '2026-11-21' }),
      ],
      decisions: [{ id: 9, title: 'Pricing tiers', createdOn: '2026-11-16' }, { id: 10, title: 'Fresh one', createdOn: '2026-11-20' }],
      budgets: [{ code: 'RIDEHOME', pct: 104 }],
      approvals: [{ id: 5, summary: 'Split rule' }],
    });
    const top = topPriorities(c, 6);
    expect(top.map((x) => x.text)).toEqual(['Renew domain', 'Review RIDEHOME spending', 'Unblock: SMS contract', 'Pitch deck', 'Decide: Pricing tiers', 'Answer: Split rule']);
    expect(top[0]!.reason).toBe('overdue 3 days · Sami');
    expect(c.some((x) => x.text.includes('Fresh one') || x.text === 'Someday')).toBe(false);
  });

  it('returns fewer than three when there is little to do', () => {
    expect(topPriorities(priorityCandidates({ ...base, tasks: [] }))).toEqual([]);
  });
});

describe('meeting streak', () => {
  it('counts consecutive fully-held weeks; skipped ones do not break it', () => {
    const recs = [
      { week: '2026-11-16', held: 1, missed: 0 },
      { week: '2026-11-09', held: 2, missed: 0 },
      { week: '2026-11-02', held: 1, missed: 0 }, // one skipped on purpose that week (not counted as missed)
      { week: '2026-10-26', held: 1, missed: 1 },
    ];
    expect(meetingStreak(recs, '2026-11-16')).toBe(3);
    // current week with nothing held yet → start from last week
    expect(meetingStreak(recs.slice(1), '2026-11-16')).toBe(2);
    // a missed meeting this week resets it
    expect(meetingStreak([{ week: '2026-11-16', held: 1, missed: 1 }, ...recs.slice(1)], '2026-11-16')).toBe(0);
    expect(weekOf('2026-11-22')).toBe('2026-11-16');
  });
});

describe('rebalance hint (facts only)', () => {
  const people = [{ userId: 1, name: 'John', open: 3 }, { userId: 2, name: 'Sami', open: 9 }];
  const tasks = [
    { id: 1, title: 'API rate limits', ownerUserId: 2, areaOwnerUserId: 1 },
    { id: 2, title: 'Call MMCY', ownerUserId: 2, areaOwnerUserId: 2 },
  ];
  it('only suggests tasks in areas the less-loaded person owns', () => {
    expect(rebalanceHint(people, tasks)).toMatchObject({ from: { name: 'Sami' }, to: { name: 'John' }, tasks: [{ id: 1 }] });
  });
  it('stays quiet when the gap is small or nothing fits', () => {
    expect(rebalanceHint([{ userId: 1, name: 'John', open: 4 }, { userId: 2, name: 'Sami', open: 6 }], tasks)).toBeNull();
    expect(rebalanceHint(people, [tasks[1]!])).toBeNull();
  });
});
