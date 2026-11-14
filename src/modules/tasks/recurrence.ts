import { DateTime } from 'luxon';

/**
 * Small recurrence helper (pure, fully tested). Dates are local calendar
 * dates 'YYYY-MM-DD'; the time of day is kept separately on the task.
 *
 *   daily    every N days
 *   weekly   every N weeks on given weekdays (1 = Mon … 7 = Sun)
 *   monthly  every N months on day D (clamped to month length) or the last day
 *
 * `anchor` is the first occurrence; intervals count from it.
 */
export type RecurrenceRule =
  | { freq: 'daily'; interval: number }
  | { freq: 'weekly'; interval: number; weekdays: number[] }
  | { freq: 'monthly'; interval: number; day: number | 'last' };

export type Recurrence = RecurrenceRule & { anchor: string };

const d = (s: string) => DateTime.fromISO(s, { zone: 'utc' });
const iso = (x: DateTime) => x.toFormat('yyyy-MM-dd');

export function matches(r: Recurrence, date: string): boolean {
  const a = d(r.anchor);
  const x = d(date);
  if (x < a) return false;
  switch (r.freq) {
    case 'daily':
      return Math.round(x.diff(a, 'days').days) % r.interval === 0;
    case 'weekly': {
      if (!r.weekdays.includes(x.weekday)) return false;
      const weeks = Math.round(x.startOf('week').diff(a.startOf('week'), 'weeks').weeks);
      return weeks % r.interval === 0;
    }
    case 'monthly': {
      const months = (x.year - a.year) * 12 + (x.month - a.month);
      if (months % r.interval !== 0) return false;
      const last = x.daysInMonth!;
      const target = r.day === 'last' ? last : Math.min(r.day, last);
      return x.day === target;
    }
  }
}

/** First occurrence strictly after `after`. */
export function nextOccurrence(r: Recurrence, after: string): string {
  let x = d(after).plus({ days: 1 });
  const a = d(r.anchor);
  if (x < a) x = a;
  const limit = 400 * Math.max(1, r.interval) + 62;
  for (let i = 0; i < limit; i++, x = x.plus({ days: 1 })) {
    if (matches(r, iso(x))) return iso(x);
  }
  throw new Error('recurrence has no next occurrence');
}

/** First occurrence on or after `date`. */
export function firstOnOrAfter(r: Recurrence, date: string): string {
  return nextOccurrence(r, iso(d(date).minus({ days: 1 })));
}

// ---------- text ----------

const DAYS: Record<string, number> = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};
const DAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday|day)?';
const DAY_LIST = `${DAY}(?:\\s*(?:,|and|&)\\s*${DAY})*`;

function parseDays(s: string): number[] {
  const out = new Set<number>();
  for (const w of s.toLowerCase().split(/\s*(?:,|and|&)\s*/)) {
    const n = DAYS[w.trim()];
    if (n) out.add(n);
  }
  return [...out].sort();
}

/**
 * Finds a recurrence phrase in free text. Returns the rule and the matched
 * phrase (so callers can remove it). `anchorWeekday` is used for plain
 * "weekly" (repeat on the weekday of the first due date).
 */
export function parseRecurrence(text: string, anchorWeekday: number): { rule: RecurrenceRule; match: string } | null {
  const tries: [RegExp, (m: RegExpExecArray) => RecurrenceRule | null][] = [
    [/\b(?:every\s+weekday|weekdays)\b/i, () => ({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })],
    [new RegExp(`\\bevery\\s+(\\d+)\\s+weeks?(?:\\s+on\\s+(${DAY_LIST}))?\\b`, 'i'), (m) => ({
      freq: 'weekly', interval: Number(m[1]), weekdays: m[2] ? parseDays(m[2]) : [anchorWeekday],
    })],
    [new RegExp(`\\b(?:every|each)\\s+(${DAY_LIST})\\b`, 'i'), (m) => ({ freq: 'weekly', interval: 1, weekdays: parseDays(m[1]!) })],
    [new RegExp(`\\b(?:weekly|every\\s+week)(?:\\s+on\\s+(${DAY_LIST}))?\\b`, 'i'), (m) => ({
      freq: 'weekly', interval: 1, weekdays: m[1] ? parseDays(m[1]) : [anchorWeekday],
    })],
    [/\bevery\s+(\d+)\s+days?\b/i, (m) => ({ freq: 'daily', interval: Number(m[1]) })],
    [/\b(?:daily|every\s+day)\b/i, () => ({ freq: 'daily', interval: 1 })],
    [/\b(?:monthly|every\s+month|every\s+(\d+)\s+months?)(?:\s+on\s+the\s+(?:(\d{1,2})(?:st|nd|rd|th)?|(last)(?:\s+day)?))?\b/i, (m) => {
      const day = m[3] ? 'last' : m[2] ? Number(m[2]) : null;
      if (typeof day === 'number' && (day < 1 || day > 31)) return null;
      return { freq: 'monthly', interval: m[1] ? Number(m[1]) : 1, day: day ?? 0 }; // 0 = fill from anchor
    }],
  ];
  for (const [re, build] of tries) {
    const m = re.exec(text);
    if (!m) continue;
    const rule = build(m);
    if (!rule) continue;
    if (rule.interval < 1 || rule.interval > 99) continue;
    if (rule.freq === 'weekly' && rule.weekdays.length === 0) continue;
    return { rule, match: m[0] };
  }
  return null;
}

/** Attach an anchor; fills "monthly" without a day from the anchor's day. */
export function withAnchor(rule: RecurrenceRule, anchor: string): Recurrence {
  if (rule.freq === 'monthly' && rule.day === 0) return { ...rule, day: d(anchor).day, anchor };
  return { ...rule, anchor };
}

const WD = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function describeRecurrence(r: RecurrenceRule): string {
  switch (r.freq) {
    case 'daily':
      return r.interval === 1 ? 'Every day' : `Every ${r.interval} days`;
    case 'weekly': {
      const days = r.weekdays.join(',') === '1,2,3,4,5' ? 'weekdays' : r.weekdays.map((w) => WD[w]).join(', ');
      if (r.interval === 1) return days === 'weekdays' ? 'Every weekday' : `Every ${days}`;
      return `Every ${r.interval} weeks on ${days}`;
    }
    case 'monthly': {
      const day = r.day === 'last' ? 'the last day' : `the ${ord(r.day)}`;
      return r.interval === 1 ? `Monthly on ${day}` : `Every ${r.interval} months on ${day}`;
    }
  }
}

export function isRecurrence(v: unknown): v is Recurrence {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.anchor !== 'string' || !d(r.anchor).isValid) return false;
  if (typeof r.interval !== 'number' || r.interval < 1) return false;
  if (r.freq === 'daily') return true;
  if (r.freq === 'weekly') return Array.isArray(r.weekdays) && r.weekdays.length > 0 && r.weekdays.every((x) => Number.isInteger(x) && x >= 1 && x <= 7);
  if (r.freq === 'monthly') return r.day === 'last' || (typeof r.day === 'number' && r.day >= 1 && r.day <= 31);
  return false;
}
