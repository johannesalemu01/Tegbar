// Fake API for ?demo=1 — lets you preview the design in any browser, no Telegram or server data needed.
const now = new Date();
const iso = (days, h = 10, m = 0) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(h - 3, m, 0, 0); return d.toISOString(); };
const date = (days) => iso(days).slice(0, 10);
const tasks = [
  { id: 1, title: 'Call MMCY about the B2B pilot', status: 'todo', priority: 'high', projectId: 11, projectCode: 'RIDEHOME', ownerUserId: 2, ownerName: 'Sami', dueDate: date(0), dueAt: iso(0, 15), areaName: 'Sales', notes: 'Ask about 20-rider trial and invoicing.' },
  { id: 2, title: 'Renew the domain', status: 'todo', priority: 'normal', projectId: 10, projectCode: 'GENERAL', ownerUserId: 1, ownerName: 'John', dueDate: date(-2), dueAt: null },
  { id: 3, title: 'Driver app v2 — OTP flow', status: 'doing', priority: 'high', projectId: 11, projectCode: 'RIDEHOME', ownerUserId: 1, ownerName: 'John', dueDate: date(3), dueAt: null, areaName: 'Engineering' },
  { id: 4, title: 'SMS gateway contract', status: 'blocked', priority: 'normal', projectId: 11, projectCode: 'RIDEHOME', ownerUserId: 2, ownerName: 'Sami', dueDate: null, dueAt: null },
  { id: 5, title: 'ቦሌ ላይ ሾፌሮች ፈልግ', status: 'todo', priority: 'low', projectId: 11, projectCode: 'RIDEHOME', ownerUserId: 2, ownerName: 'Sami', dueDate: date(5), dueAt: null },
  { id: 6, title: 'Set up VPS backups', status: 'done', priority: 'normal', projectId: 11, projectCode: 'RIDEHOME', ownerUserId: 1, ownerName: 'John', dueDate: date(-1), dueAt: null, completedAt: iso(-1) },
];
const meetings = [
  { id: 21, title: 'Weekly sync', startAt: iso(2, 19), endAt: iso(2, 20), mode: 'virtual', link: 'https://meet.google.com/abc-defg-hij', hostName: 'John', place: null, status: 'scheduled', rsvps: [] },
  { id: 22, title: 'Weekly sit-down', startAt: iso(6, 10), endAt: iso(6, 11, 30), mode: 'in_person', link: null, hostName: 'Sami', place: { name: 'The Spot', address: 'Kazanchis, Addis Ababa' }, status: 'scheduled', rsvps: [] },
];
const db = {
  me: { userId: 1, workspaceId: 1, displayName: 'John', handle: 'john', seat: 'A', role: 'owner', timezone: 'Africa/Addis_Ababa', currentProject: { id: 11, code: 'RIDEHOME', name: 'RideHome' }, serverTime: now.toISOString() },
  members: [{ userId: 1, displayName: 'John' }, { userId: 2, displayName: 'Sami' }],
  projects: [{ id: 11, code: 'RIDEHOME', name: 'RideHome' }, { id: 10, code: 'GENERAL', name: 'General' }],
  approvals: [{ id: 7, summary: 'Change the split rule of RIDEHOME → John 60% / Sami 40%', kind: 'costs.split_rule' }],
  notices: [{ id: 3, level: 'urgent', body: 'SMS gateway is down — riders get no OTP', projectCode: 'RIDEHOME' }],
};
const month = now.toISOString().slice(0, 7);
const shift = (n) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + n, 1)); return d.toISOString().slice(0, 7); };

export async function demoFetch(path, opts = {}) {
  const url = new URL(path, 'http://demo');
  const p = url.pathname.replace('/api/v1', '');
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  await new Promise((r) => setTimeout(r, 120));
  if (p === '/me') return db.me;
  if (p === '/members') return db.members;
  if (p === '/projects') return db.projects;
  if (p === '/overview') {
    const mine = tasks.filter((t) => t.ownerUserId === 1 && t.status !== 'done');
    return {
      counts: { today: mine.filter((t) => t.dueDate === date(0)).length, overdue: mine.filter((t) => t.dueDate && t.dueDate < date(0)).length, open: mine.length },
      nextMeeting: meetings[0], approvals: db.approvals, notices: db.notices,
    };
  }
  if (p === '/tasks' && method === 'GET') return { items: tasks, total: tasks.length };
  if (p === '/tasks' && method === 'POST') {
    const t = { id: tasks.length + 10, title: body.text ?? body.title, status: 'todo', priority: 'normal', projectId: 11, projectCode: 'RIDEHOME', ownerUserId: 1, ownerName: 'John', dueDate: null, dueAt: null };
    tasks.unshift(t);
    return t;
  }
  const tm = /^\/tasks\/(\d+)$/.exec(p);
  if (tm) {
    const t = tasks.find((x) => x.id === Number(tm[1]));
    if (method === 'DELETE') { tasks.splice(tasks.indexOf(t), 1); return null; }
    Object.assign(t, body);
    if (body.ownerUserId) t.ownerName = db.members.find((m) => m.userId === body.ownerUserId).displayName;
    if (body.status === 'done') t.completedAt = new Date().toISOString();
    return { task: t, changed: true };
  }
  if (p === '/meetings') return meetings;
  if (/^\/meetings\/\d+\/rsvp$/.test(p)) return { changed: true };
  if (/^\/approvals\/\d+\/(approve|reject)$/.test(p)) { db.approvals = []; return {}; }
  if (/^\/notices\/\d+\/ack$/.test(p)) { db.notices = []; return {}; }
  if (p === '/costs/summary') {
    const m = url.searchParams.get('month') ?? month;
    const scale = m === month ? 1 : 0.7;
    return {
      month: m,
      totals: [{ currency: 'ETB', amountMinor: Math.round(3_735_050 * scale) }],
      byCategory: [
        { name: 'Other', currency: 'ETB', amountMinor: Math.round(2_000_000 * scale) },
        { name: 'Hosting & servers', currency: 'ETB', amountMinor: Math.round(1_200_000 * scale) },
        { name: 'SMS & maps', currency: 'ETB', amountMinor: Math.round(450_000 * scale) },
        { name: 'Travel', currency: 'ETB', amountMinor: Math.round(85_050 * scale) },
      ],
      trend: [-5, -4, -3, -2, -1, 0].map((k, i) => ({ month: shift(k), currency: 'ETB', amountMinor: [900_000, 1_400_000, 1_100_000, 2_300_000, 2_600_000, 3_735_050][i] })),
      balance: [{ currency: 'ETB', transfers: [{ from: 2, to: 1, amount: 467_525 }] }],
      budget: null,
      recent: [
        { id: 5, amountMinor: 85_050, currency: 'ETB', categoryName: 'Travel', date: date(-1), payerName: 'John', note: 'Ride to Bole, MMCY', status: 'active' },
        { id: 2, amountMinor: 450_000, currency: 'ETB', categoryName: 'SMS & maps', date: date(-4), payerName: 'Sami', note: 'የኤስኤምኤስ ጥቅል', status: 'active' },
        { id: 1, amountMinor: 1_200_000, currency: 'ETB', categoryName: 'Hosting & servers', date: date(-9), payerName: 'John', note: 'VPS + backups', status: 'active' },
      ],
    };
  }
  throw Object.assign(new Error(`demo: no route ${method} ${p}`), { status: 404 });
}
