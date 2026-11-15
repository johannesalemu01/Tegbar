// Pure helpers for the Tegbar Mini App (no DOM, no network) — unit-tested in test/miniapp.test.ts.

/** Integer minor units → "1,500.50 ETB". Integer maths only: money never passes through floats. */
export function fmtMoney(minor, currency = 'ETB', withCode = true) {
  const neg = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const int = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '−' : ''}${int}.${frac}${withCode ? ` ${currency}` : ''}`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** "YYYY-MM-DD" of an ISO instant in a time zone. */
export function dayKey(iso, tz) {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  const toUtc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Today", "Tomorrow", "Yesterday", "Fri 20 Nov". */
export function relDay(key, todayKey) {
  const diff = diffDays(key, todayKey);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WD[wd]} ${d} ${MON[m - 1]}`;
}

export function weekdayShort(key) {
  const [y, m, d] = key.split('-').map(Number);
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function fmtTime(iso, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function localHour(iso, tz) {
  return Number(fmtTime(iso, tz).slice(0, 2));
}

export function greeting(hour) {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Is a task overdue right now? (date-only tasks: overdue from the next day) */
export function isOverdue(task, nowIso, tz) {
  if (task.status === 'done' || !task.dueDate) return false;
  return task.dueAt ? task.dueAt < nowIso : task.dueDate < dayKey(nowIso, tz);
}

/** Due label for a task card. */
export function dueLabel(task, nowIso, tz) {
  if (!task.dueDate) return null;
  const day = relDay(task.dueDate, dayKey(nowIso, tz));
  return task.dueAt ? `${day}, ${fmtTime(task.dueAt, tz)}` : day;
}

export const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
];

/** Board columns; open columns sorted by due date (undated last) then priority. */
export function columns(tasks) {
  const rank = { high: 0, normal: 1, low: 2 };
  const out = { todo: [], doing: [], blocked: [], done: [] };
  for (const t of tasks) (out[t.status] ?? out.todo).push(t);
  for (const k of ['todo', 'doing', 'blocked']) {
    out[k].sort((a, b) => (a.dueDate ?? '9999') .localeCompare(b.dueDate ?? '9999') || (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || rank[a.priority] - rank[b.priority] || a.id - b.id);
  }
  out.done.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  return out;
}

/** Days from today with meetings and dated tasks, for the calendar tab. */
export function agenda(meetings, tasks, tz, todayKey, days = 14) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const key = addDays(todayKey, i);
    const items = [
      ...meetings.filter((m) => dayKey(m.startAt, tz) === key && m.status !== 'cancelled').map((m) => ({ kind: 'meeting', sort: m.startAt, m })),
      ...tasks.filter((t) => t.status !== 'done' && t.dueDate === key).map((t) => ({ kind: 'task', sort: t.dueAt ?? `${key}T99`, t })),
    ].sort((a, b) => a.sort.localeCompare(b.sort));
    out.push({ key, label: relDay(key, todayKey), items });
  }
  return out;
}

/** Bar heights in % (0–100) for a small chart; 4% minimum for non-zero values so they stay visible. */
export function barHeights(values) {
  const max = Math.max(0, ...values);
  return values.map((v) => (max === 0 || v <= 0 ? 0 : Math.max(4, Math.round((v / max) * 100))));
}

export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month, short = false) {
  const [y, m] = month.split('-').map(Number);
  return short ? MON[m - 1] : `${MONTH_LONG[m - 1]} ${y}`;
}

/** Last n months ending at `month`, filled with zeros. */
export function trendSeries(trend, month, currency, n = 6) {
  const months = Array.from({ length: n }, (_, i) => shiftMonth(month, i - n + 1));
  return months.map((mo) => ({ month: mo, amountMinor: trend.filter((x) => x.month === mo && x.currency === currency).reduce((a, x) => a + x.amountMinor, 0) }));
}

/** Human balance lines from the API's balance views. */
export function balanceLines(balance, names) {
  const out = [];
  for (const b of balance) for (const tr of b.transfers) out.push({ text: `${names[tr.from] ?? '?'} owes ${names[tr.to] ?? '?'}`, amount: fmtMoney(tr.amount, b.currency) });
  return out;
}
