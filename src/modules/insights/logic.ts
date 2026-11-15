import { DateTime } from 'luxon';

/**
 * Pure rules behind the Friday brief and the workload view (tested).
 * Facts only: nothing here ranks people.
 */

export function weekOf(dateKey: string): string {
  return DateTime.fromISO(dateKey, { zone: 'utc' }).startOf('week').toFormat('yyyy-MM-dd');
}

export function daysBetween(a: string, b: string): number {
  return Math.round(DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'days').days);
}

// ---------- three priorities ----------

export interface PriorityCandidate {
  key: string; // dedupe key, e.g. "task:12"
  text: string;
  reason: string;
  score: number;
}

export interface OpenTaskFact {
  id: number;
  title: string;
  status: 'todo' | 'doing' | 'blocked';
  priority: 'low' | 'normal' | 'high';
  dueDate: string | null;
  overdue: boolean;
  ownerName: string | null;
}

/**
 * Scoring (higher first):
 *   overdue          60 + days overdue (max 20), +10 if high priority
 *   pending budget   50 at ≥100 %, 30 at ≥80 %
 *   blocked          45, +10 if high
 *   pending decision 40 once it has waited 2+ days
 *   approval waiting 38
 *   high, due ≤7d    35 + (7 − days)
 *   normal, due ≤3d  20 + (3 − days)
 */
export function priorityCandidates(input: {
  today: string;
  tasks: OpenTaskFact[];
  decisions: { id: number; title: string; createdOn: string }[];
  budgets: { code: string; pct: number }[];
  approvals: { id: number; summary: string }[];
}): PriorityCandidate[] {
  const out: PriorityCandidate[] = [];
  for (const t of input.tasks) {
    const who = t.ownerName ?? 'unassigned';
    const high = t.priority === 'high' ? 10 : 0;
    if (t.overdue && t.dueDate) {
      const days = Math.max(0, daysBetween(t.dueDate, input.today));
      out.push({ key: `task:${t.id}`, text: t.title, reason: `overdue ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`} · ${who}`, score: 60 + Math.min(days, 20) + high });
    } else if (t.status === 'blocked') {
      out.push({ key: `task:${t.id}`, text: `Unblock: ${t.title}`, reason: `blocked · ${who}`, score: 45 + high });
    } else if (t.dueDate) {
      const days = daysBetween(input.today, t.dueDate);
      if (t.priority === 'high' && days >= 0 && days <= 7) out.push({ key: `task:${t.id}`, text: t.title, reason: `high priority, due in ${days} day${days === 1 ? '' : 's'} · ${who}`, score: 35 + (7 - days) });
      else if (t.priority === 'normal' && days >= 0 && days <= 3) out.push({ key: `task:${t.id}`, text: t.title, reason: `due in ${days} day${days === 1 ? '' : 's'} · ${who}`, score: 20 + (3 - days) });
    }
  }
  for (const b of input.budgets) {
    if (b.pct >= 100) out.push({ key: `budget:${b.code}`, text: `Review ${b.code} spending`, reason: `${b.pct}% of budget used`, score: 50 });
    else if (b.pct >= 80) out.push({ key: `budget:${b.code}`, text: `Watch ${b.code} spending`, reason: `${b.pct}% of budget used`, score: 30 });
  }
  for (const d of input.decisions) {
    const waited = daysBetween(d.createdOn, input.today);
    if (waited >= 2) out.push({ key: `decision:${d.id}`, text: `Decide: ${d.title}`, reason: `proposed ${waited} days ago`, score: 40 });
  }
  for (const a of input.approvals) out.push({ key: `approval:${a.id}`, text: `Answer: ${a.summary}`, reason: 'waiting for your second key', score: 38 });
  return out;
}

export function topPriorities(c: PriorityCandidate[], n = 3): PriorityCandidate[] {
  const seen = new Set<string>();
  return [...c]
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x.score - a.x.score || a.i - b.i)
    .map(({ x }) => x)
    .filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
    .slice(0, n);
}

// ---------- meeting streak ----------

export interface WeekRecord {
  week: string; // Monday
  held: number;
  missed: number; // past, never started/ended (not skipped on purpose)
}

/**
 * Consecutive weeks (newest first) in which every planned meeting was held.
 * Skipped-on-purpose meetings don't break it; a week with nothing held
 * doesn't extend it. The current week counts only once something was held.
 */
export function meetingStreak(records: WeekRecord[], currentWeek: string): number {
  const byWeek = new Map(records.map((r) => [r.week, r]));
  let streak = 0;
  let w = DateTime.fromISO(currentWeek, { zone: 'utc' });
  const cur = byWeek.get(currentWeek);
  if (!cur || cur.held === 0 || cur.missed > 0) {
    if (cur && cur.missed > 0) return 0;
    w = w.minus({ weeks: 1 }); // current week not done yet: start from last week
  }
  for (let i = 0; i < 520; i++, w = w.minus({ weeks: 1 })) {
    const r = byWeek.get(w.toFormat('yyyy-MM-dd'));
    if (!r || r.held === 0 || r.missed > 0) break;
    streak++;
  }
  return streak;
}

// ---------- workload hint ----------

/**
 * Facts-only rebalancing hint: only when one person has at least 5 open
 * tasks and at least twice as many as another person, and some of those
 * tasks sit in areas the other person owns. Returns null otherwise.
 */
export function rebalanceHint(
  people: { userId: number; name: string; open: number }[],
  openTasks: { id: number; title: string; ownerUserId: number | null; areaOwnerUserId: number | null }[],
): { from: { userId: number; name: string; open: number }; to: { userId: number; name: string; open: number }; tasks: { id: number; title: string }[] } | null {
  if (people.length < 2) return null;
  const sorted = [...people].sort((a, b) => b.open - a.open);
  const from = sorted[0]!;
  const to = sorted.at(-1)!;
  if (from.open < 5 || from.open < 2 * Math.max(1, to.open)) return null;
  const tasks = openTasks.filter((t) => t.ownerUserId === from.userId && t.areaOwnerUserId === to.userId).slice(0, 3).map((t) => ({ id: t.id, title: t.title }));
  return tasks.length ? { from, to, tasks } : null;
}
