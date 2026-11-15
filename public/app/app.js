// Tegbar Mini App. Vanilla JS, no build step. All user text is inserted with textContent (never innerHTML).
import * as core from './core.js';

const tg = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const $ = (s) => document.querySelector(s);

const state = { me: null, members: [], projects: [], tab: 'home', projectId: null, month: null, tasks: [] };

// ---------- tiny DOM helper ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'css') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
}
const haptic = (k = 'light') => tg?.HapticFeedback?.impactOccurred?.(k);
const confirm = (msg) => new Promise((res) => (tg?.showConfirm ? tg.showConfirm(msg, res) : res(window.confirm(msg))));
const openLink = (url) => (tg?.openLink ? tg.openLink(url) : window.open(url, '_blank', 'noopener'));

// ---------- API ----------
let demoFetch = null;
async function api(path, opts = {}) {
  if (DEMO) {
    demoFetch ??= (await import('./demo.js')).demoFetch;
    return demoFetch(`/api/v1${path}`, opts);
  }
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: { authorization: `tma ${tg?.initData ?? ''}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}
const send = (path, method, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

// ---------- theme ----------
function applyScheme() {
  // Inside Telegram follow its theme; in a plain browser (preview) follow the device.
  const dark = tg?.initData ? tg.colorScheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.scheme = dark ? 'dark' : 'light';
}

// ---------- shared bits ----------
const tz = () => state.me?.timezone ?? 'Africa/Addis_Ababa';
const nowIso = () => new Date().toISOString();
const today = () => core.dayKey(nowIso(), tz());
const name = (id) => state.members.find((m) => m.userId === id)?.displayName ?? '?';
const names = () => Object.fromEntries(state.members.map((m) => [m.userId, m.displayName]));
const empty = (text) => h('div', { class: 'empty' }, text);

function render(...nodes) {
  // Views return nested arrays; flatten fully and drop empty slots.
  $('#view').replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
}

function errorView(err) {
  if (err.status === 401 || err.status === 403) {
    return h('div', { class: 'banner' }, 'Open this dashboard from the Tegbar bot (menu button “Dashboard”). ', DEMO ? '' : 'For a design preview, add ?demo=1 to the address.');
  }
  return h('div', { class: 'card' }, h('div', null, 'Something went wrong: ', err.message), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => show(state.tab) }, 'Try again')));
}

function scopeChips() {
  const el = $('#scope');
  const chips = [{ id: null, code: 'All' }, ...state.projects];
  el.replaceChildren(...chips.map((p) => h('button', {
    class: `chip ${state.projectId === p.id ? 'on' : ''}`, role: 'tab',
    onclick: () => { state.projectId = p.id; haptic('soft'); scopeChips(); show(state.tab); },
  }, p.code)));
}

// ---------- Home ----------
async function home() {
  const o = await api('/overview');
  const hour = core.localHour(nowIso(), tz());
  const parts = [
    h('div', { class: 'hello' }, `${core.greeting(hour)}, ${state.me.displayName}`),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { class: 'num' }, o.counts.today), h('span', null, 'Due today')),
      h('div', { class: `stat ${o.counts.overdue ? 'warm' : ''}` }, h('b', { class: 'num' }, o.counts.overdue), h('span', null, 'Overdue')),
      h('div', { class: 'stat' }, h('b', { class: 'num' }, o.counts.open), h('span', null, 'Open')),
    ),
  ];
  if (o.notices.length) {
    parts.push(h('div', { class: 'h' }, 'Needs your attention'));
    for (const n of o.notices) {
      parts.push(h('div', { class: `card level-${n.level}` },
        h('div', { class: 'row' }, h('span', { class: `pill ${n.level === 'urgent' ? 'warm' : 'accent'}` }, n.level), h('span', { class: 'pill code' }, n.projectCode)),
        h('div', { css: { 'margin-top': '8px' } }, n.body),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; await send(`/notices/${n.id}/ack`, 'POST', {}); haptic('medium'); toast('Acknowledged'); show('home'); } }, '✓ Acknowledged')),
      ));
    }
  }
  if (o.nextMeeting) {
    const m = o.nextMeeting;
    const day = core.relDay(core.dayKey(m.startAt, tz()), today());
    parts.push(h('div', { class: 'h' }, 'Next meeting'), h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { css: { 'font-weight': '650' } }, m.title), h('div', { class: 'muted' }, `${day} · ${core.fmtTime(m.startAt, tz())}–${core.fmtTime(m.endAt, tz())}`)),
        h('span', { class: 'pill accent' }, m.mode === 'virtual' ? 'Virtual' : 'In person')),
      h('div', { class: 'muted', css: { 'margin-top': '6px' } }, m.mode === 'virtual' ? (m.link ? m.link.replace('https://', '') : '⚠️ No Meet link yet') : m.place ?? '', m.hostName ? ` · host ${m.hostName}` : ''),
      m.link ? h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => openLink(m.link) }, '▶ Join Meet')) : null,
    ));
  }
  if (o.approvals.length) {
    parts.push(h('div', { class: 'h' }, 'Waiting for your second key'));
    for (const a of o.approvals) {
      const decide = async (approve) => {
        if (!(await confirm(approve ? 'Approve this request?' : 'Reject this request?'))) return;
        await send(`/approvals/${a.id}/${approve ? 'approve' : 'reject'}`, 'POST', {});
        haptic('medium');
        toast(approve ? 'Approved' : 'Rejected');
        show('home');
      };
      parts.push(h('div', { class: 'card' }, h('div', null, a.summary),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => decide(true) }, '✓ Approve'), h('button', { class: 'btn danger', onclick: () => decide(false) }, '✕ Reject'))));
    }
  }
  if (!o.notices.length && !o.approvals.length && !o.counts.overdue) parts.push(h('div', { class: 'card muted' }, '✦ All clear. Nothing urgent waiting for you.'));
  render(parts);
}

// ---------- Board ----------
async function loadTasks() {
  const query = (status, pageSize) => new URLSearchParams({ owner: 'all', status, pageSize, ...(state.projectId ? { project: String(state.projectId) } : {}) });
  const [open, done] = await Promise.all([api(`/tasks?${query('open', '100')}`), api(`/tasks?${query('done', '15')}`)]);
  state.tasks = [...open.items, ...done.items.filter((d) => !open.items.some((o) => o.id === d.id))];
  return state.tasks;
}

function taskCard(t) {
  const overdue = core.isOverdue(t, nowIso(), tz());
  const due = core.dueLabel(t, nowIso(), tz());
  return h('button', { class: `task ${t.priority === 'high' ? 'high' : ''} ${t.status === 'done' ? 'done' : ''}`, onclick: () => openTask(t) },
    h('div', { class: 't' }, t.title),
    h('div', { class: 'meta' },
      state.projectId ? null : h('span', { class: 'pill code' }, t.projectCode),
      due ? h('span', { class: `pill ${overdue ? 'warm' : ''}` }, overdue ? `Overdue · ${due}` : due) : null,
      t.areaName ? h('span', null, t.areaName) : null,
      h('span', { class: 'avatar', title: t.ownerName ?? 'Unassigned' }, t.ownerName ? core.initials(t.ownerName) : '–'),
    ));
}

async function board() {
  const tasks = await loadTasks();
  const cols = core.columns(tasks);
  const input = h('input', { placeholder: 'Add a task… e.g. Call MMCY friday 10am @sami !high', enterkeyhint: 'done', maxlength: '500' });
  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await send('/tasks', 'POST', { text });
      haptic('medium');
      toast('Added');
      input.value = '';
      show('board');
    } catch (err) {
      if (err.status === 422) toast('Not sure about part of that — add it from the chat to review.');
      else toast(err.message);
    } finally {
      input.disabled = false;
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  render(
    h('div', { class: 'add' }, input, h('button', { class: 'btn primary', onclick: add }, 'Add')),
    h('div', { class: 'board' }, core.COLUMNS.map((c) =>
      h('section', { class: 'col' },
        h('div', { class: 'col-h' }, h('span', null, c.label), h('span', { class: 'num' }, cols[c.key].length)),
        cols[c.key].length ? cols[c.key].map(taskCard) : empty(c.key === 'blocked' ? 'Nothing blocked' : 'Empty'),
      ))),
  );
}

// ---------- task sheet ----------
function openSheet(content) {
  const s = $('#sheet');
  s.querySelector('.sheet-body').replaceChildren(...content);
  s.hidden = false;
  tg?.BackButton?.show();
}
function closeSheet() {
  $('#sheet').hidden = true;
  tg?.BackButton?.hide();
}

function openTask(t) {
  const patch = async (body, msg) => {
    await send(`/tasks/${t.id}`, 'PATCH', body);
    haptic('medium');
    toast(msg);
    closeSheet();
    show(state.tab);
  };
  const due = core.dueLabel(t, nowIso(), tz());
  openSheet([
    h('h2', null, t.title),
    h('div', { class: 'meta' }, h('span', { class: 'pill code' }, t.projectCode), t.areaName ? h('span', null, t.areaName) : null, h('span', null, `T${t.id}`)),
    h('div', { class: 'muted', css: { 'margin-top': '8px' } }, `👤 ${t.ownerName ?? 'Unassigned'} · 🗓 ${due ?? 'No due date'}${t.priority !== 'normal' ? ` · ${t.priority} priority` : ''}`),
    t.notes ? h('div', { class: 'notes' }, t.notes) : null,
    h('div', { class: 'seg' }, core.COLUMNS.map((c) => h('button', { class: t.status === c.key ? 'on' : '', onclick: () => t.status !== c.key && patch({ status: c.key }, c.key === 'done' ? '✓ Done' : `Moved to ${c.label}`) }, c.label))),
    h('div', { class: 'h' }, 'Owner'),
    h('div', { class: 'actions' }, state.members.map((m) => h('button', { class: `btn ${t.ownerUserId === m.userId ? 'primary' : ''}`, onclick: () => t.ownerUserId !== m.userId && patch({ ownerUserId: m.userId }, `Assigned to ${m.displayName}`) }, m.displayName))),
    h('div', { class: 'actions', css: { 'margin-top': '18px' } },
      t.status !== 'done' ? h('button', { class: 'btn primary', onclick: () => patch({ status: 'done' }, '✓ Done') }, '✓ Mark done') : null,
      h('button', { class: 'btn danger', onclick: async () => { if (await confirm('Delete this task? You can restore it with /undo in the chat.')) { await send(`/tasks/${t.id}`, 'DELETE'); toast('Deleted'); closeSheet(); show(state.tab); } } }, 'Delete'),
      h('button', { class: 'btn ghost', onclick: closeSheet }, 'Close'),
    ),
  ]);
}

// ---------- Calendar ----------
async function calendar() {
  const [meetings, tasks] = await Promise.all([api('/meetings?limit=12'), loadTasks()]);
  const scoped = state.projectId ? meetings.filter((m) => m.projectId === state.projectId || !m.projectId) : meetings;
  const days = core.agenda(scoped, tasks, tz(), today(), 14);
  const week = days.slice(0, 7);
  const rsvp = async (m, status, lateMinutes) => {
    await send(`/meetings/${m.id}/rsvp`, 'POST', lateMinutes ? { status, lateMinutes } : { status });
    haptic('light');
    toast(status === 'going' ? 'Going ✓' : status === 'late' ? `Running ${lateMinutes} min late` : 'Can’t make it — propose a new time in the chat');
  };
  render(
    h('div', { class: 'week' }, week.map((d) => {
      const [, , dd] = d.key.split('-');
      return h('div', { class: `day ${d.key === today() ? 'today' : ''}` }, core.weekdayShort(d.key), h('b', { class: 'num' }, Number(dd)), d.items.length ? h('div', { class: 'dot' }) : null);
    })),
    days.filter((d) => d.items.length).map((d) => [
      h('div', { class: 'h' }, d.label),
      h('div', { class: 'card' }, d.items.map((it) => it.kind === 'meeting'
        ? h('div', { class: 'slot' },
          h('div', { class: 'time num' }, core.fmtTime(it.m.startAt, tz())),
          h('div', null,
            h('div', { css: { 'font-weight': '620' } }, `◉ ${it.m.title}`),
            h('div', { class: 'muted' }, it.m.mode === 'virtual' ? (it.m.link ? 'Virtual · Meet link ready' : 'Virtual · ⚠️ no link yet') : `In person · ${it.m.place?.name ?? ''}`, it.m.hostName ? ` · host ${it.m.hostName}` : ''),
            h('div', { class: 'actions' },
              it.m.link ? h('button', { class: 'btn primary', onclick: () => openLink(it.m.link) }, '▶ Join') : null,
              h('button', { class: 'btn', onclick: () => rsvp(it.m, 'going') }, '✓ Going'),
              h('button', { class: 'btn', onclick: () => rsvp(it.m, 'late', 10) }, '+10'),
              h('button', { class: 'btn ghost', onclick: () => rsvp(it.m, 'no') }, 'Can’t'),
            )))
        : h('div', { class: 'slot' },
          h('div', { class: 'time num' }, it.t.dueAt ? core.fmtTime(it.t.dueAt, tz()) : 'All day'),
          h('button', { class: 'grow', css: { 'text-align': 'left' }, onclick: () => openTask(it.t) }, h('div', null, `○ ${it.t.title}`), h('div', { class: 'muted' }, `${it.t.projectCode} · ${it.t.ownerName ?? 'Unassigned'}`))))),
    ]),
    days.every((d) => !d.items.length) ? empty('Nothing in the next two weeks.') : null,
  );
}

// ---------- Costs ----------
async function costs() {
  state.month ??= core.dayKey(nowIso(), tz()).slice(0, 7);
  const q = new URLSearchParams({ month: state.month, ...(state.projectId ? { project: String(state.projectId) } : {}) });
  const s = await api(`/costs/summary?${q}`);
  const cur = s.totals[0]?.currency ?? 'ETB';
  const series = core.trendSeries(s.trend, state.month, cur, 6);
  const heights = core.barHeights(series.map((x) => x.amountMinor));
  const maxCat = Math.max(1, ...s.byCategory.map((c) => c.amountMinor));
  const balance = core.balanceLines(s.balance, names());
  const go = (n) => { state.month = core.shiftMonth(state.month, n); haptic('soft'); show('costs'); };
  render(
    h('div', { class: 'card' },
      h('div', { class: 'month' }, h('button', { class: 'btn ghost', onclick: () => go(-1), 'aria-label': 'Previous month' }, '‹'), h('span', { css: { 'font-weight': '620' } }, core.monthLabel(state.month)), h('button', { class: 'btn ghost', onclick: () => go(1), 'aria-label': 'Next month' }, '›')),
      h('div', { class: 'total num' }, s.totals.length ? s.totals.map((x) => core.fmtMoney(x.amountMinor, x.currency)).join(' + ') : core.fmtMoney(0)),
      h('div', { class: 'bars' }, series.map((x, i) => h('div', null, h('div', { class: `bar ${x.month === state.month ? 'now' : ''}`, css: { height: `${heights[i]}%` }, title: core.fmtMoney(x.amountMinor, cur) })))),
      h('div', { class: 'labels' }, series.map((x) => h('div', { class: 'bar-l' }, core.monthLabel(x.month, true)))),
    ),
    h('div', { class: 'card' },
      h('div', { css: { 'font-weight': '620', 'margin-bottom': '4px' } }, '⚖ Balance'),
      balance.length ? balance.map((b) => h('div', { class: 'row' }, h('span', { class: 'grow' }, b.text), h('b', { class: 'num' }, b.amount))) : h('div', { class: 'muted' }, 'All square ✓'),
      s.budget ? h('div', { class: 'muted', css: { 'margin-top': '8px' } }, `🎯 ${s.budget.pct}% of budget used`) : null,
    ),
    s.byCategory.length ? [h('div', { class: 'h' }, 'By category'), h('div', { class: 'card list' }, s.byCategory.map((c) => h('div', { class: 'item' },
      h('div', { class: 'row' }, h('span', { class: 'grow ellipsis' }, c.name), h('span', { class: 'num' }, core.fmtMoney(c.amountMinor, c.currency, false))),
      h('div', { class: 'hbar' }, h('i', { css: { width: `${Math.max(2, Math.round((c.amountMinor / maxCat) * 100))}%` } })))))] : null,
    h('div', { class: 'h' }, 'Recent'),
    s.recent.length ? h('div', { class: 'card list' }, s.recent.map((c) => h('div', { class: 'item row' },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, c.note || c.categoryName), h('div', { class: 'muted' }, `${core.relDay(c.date, today())} · ${c.categoryName} · ${c.payerName}`)),
      h('b', { class: 'num' }, core.fmtMoney(c.amountMinor, c.currency, false))))) : empty('No costs this month. Record one with /spend in the chat.'),
  );
}

// ---------- routing ----------
const VIEWS = { home, board, calendar, costs };
async function show(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  try {
    await VIEWS[tab]();
  } catch (err) {
    render(errorView(err));
  }
}

async function boot() {
  applyScheme();
  tg?.ready();
  tg?.expand();
  tg?.onEvent?.('themeChanged', applyScheme);
  tg?.BackButton?.onClick(closeSheet);
  $('#sheet').addEventListener('click', (e) => e.target.id === 'sheet' && closeSheet());
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => { haptic('soft'); show(b.dataset.tab); });
  if (!DEMO && !tg?.initData) {
    render(h('div', { class: 'banner' }, 'Open this dashboard from the Tegbar bot (menu button “Dashboard”). For a design preview, add ?demo=1 to the address.'));
    return;
  }
  try {
    [state.me, state.members, state.projects] = await Promise.all([api('/me'), api('/members'), api('/projects')]);
  } catch (err) {
    render(errorView(err));
    return;
  }
  scopeChips();
  show(params.get('tab') && VIEWS[params.get('tab')] ? params.get('tab') : 'home');
}

boot();
