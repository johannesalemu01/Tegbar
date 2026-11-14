import type { DateTime } from 'luxon';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { EventRow } from '../../core/services/events.js';
import { fmtDateTime, fmtDay, fmtStamp, fromDb, localDate, toDb, type TimeFormat } from '../../core/time.js';
import { b, clip, code, esc, i, quote } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE, STATUS_GLYPH } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import type { Due, Issue } from './quickadd.js';
import { describeRecurrence, isRecurrence, type Recurrence } from './recurrence.js';
import type { Priority, TaskStatus } from './schema.js';
import type { DueFilter, OwnerFilter, StatusFilter, TaskFilter, TaskView } from './service.js';

// ---------- list state (encoded into callback_data) ----------

export type ViewKey = 'my' | 'ours' | 'today' | 'week' | 'overdue' | 'rec';
const VIEW_KEYS: readonly ViewKey[] = ['my', 'ours', 'today', 'week', 'overdue', 'rec'];

export interface ListState {
  v: ViewKey;
  pg: number;
  /** 'm' me, 'a' everyone, or base36 user id */
  o: string;
  /** 'a' all projects or base36 project id */
  pj: string;
  /** o open, b blocked, d done, a all */
  s: 'o' | 'b' | 'd' | 'a';
}

export const NO_STATE = '-';

export function encState(s: ListState): string {
  return `${s.v}.${s.pg}.${s.o}.${s.pj}.${s.s}`;
}

export function decState(raw: string | undefined): ListState | null {
  if (!raw || raw === NO_STATE) return null;
  const [v, pg, o, pj, s] = raw.split('.');
  if (!VIEW_KEYS.includes(v as ViewKey)) return null;
  const page = Number(pg);
  if (!Number.isInteger(page) || page < 0 || page > 999) return null;
  if (!o || !(o === 'm' || o === 'a' || dec(o))) return null;
  if (!pj || !(pj === 'a' || dec(pj))) return null;
  if (!s || !['o', 'b', 'd', 'a'].includes(s)) return null;
  return { v: v as ViewKey, pg: page, o, pj, s: s as ListState['s'] };
}

export function defaultState(v: ViewKey, currentProjectId: number, projectOverride?: number): ListState {
  const pj = projectOverride ? enc(projectOverride) : v === 'ours' ? enc(currentProjectId) : 'a';
  return { v, pg: 0, o: v === 'my' ? 'm' : 'a', pj, s: 'o' };
}

export function stateToFilter(s: ListState): TaskFilter {
  const owner: OwnerFilter = s.o === 'm' ? 'me' : s.o === 'a' ? 'all' : dec(s.o)!;
  const status: StatusFilter = ({ o: 'open', b: 'blocked', d: 'done', a: 'all' } as const)[s.s];
  const due: DueFilter = s.v === 'today' ? 'today' : s.v === 'week' ? 'week' : s.v === 'overdue' ? 'overdue' : 'any';
  return { owner, projectId: s.pj === 'a' ? null : dec(s.pj), status, due, ...(s.v === 'rec' ? { recurring: true } : {}) };
}

// ---------- shared bits ----------

export interface Lookup {
  now: DateTime;
  fmt: TimeFormat;
  meUserId: number;
  members: { userId: number; name: string }[];
  projects: { id: number; code: string; name: string }[];
  areas: Map<number, string>;
}

export function isOverdue(task: Pick<TaskView, 'status' | 'due_at' | 'due_date'>, now: DateTime): boolean {
  if (task.status === 'done' || !task.due_date) return false;
  return task.due_at ? task.due_at < toDb(now) : task.due_date < localDate(now);
}

export function dueLabel(task: Pick<TaskView, 'status' | 'due_at' | 'due_date'>, l: Lookup, opts: { plain?: boolean } = {}): string | null {
  if (!task.due_date) return null;
  const s = task.due_at ? fmtDateTime(fromDb(task.due_at), l.now, l.fmt) : fmtDay(task.due_date, l.now);
  return !opts.plain && isOverdue(task, l.now) ? `${b(t('task.overdue'))} ${G.dot} ${s}` : s;
}

function draftDueLabel(due: Due | null, l: Lookup): string | null {
  if (!due) return null;
  const day = fmtDay(due.date, l.now);
  if (!due.time) return day;
  const [h, m] = due.time.split(':').map(Number);
  const dt = l.now.set({ hour: h!, minute: m! });
  return `${day}, ${l.fmt === '24h' ? due.time : dt.toFormat('h:mm a')}`;
}

const priorityGlyph = (p: Priority) => (p === 'high' ? ` ${G.high}` : p === 'low' ? ` ${G.low}` : '');
const statusLabel = (s: TaskStatus) => t(`task.status.${s}`);
const priorityLabel = (p: Priority) => t(`task.priority.${p}`);
export const taskRef = (id: number) => `T${id}`;

/** One compact line for digests and reminders. */
export function taskLine(task: TaskView, l: Lookup, opts: { owner?: boolean; project?: boolean } = {}): string {
  const meta = [
    dueLabel(task, l),
    opts.project === false ? null : code(task.project_code),
    opts.owner ? (task.owner_name ? esc(task.owner_name) : i(t('task.unassigned'))) : null,
  ].filter(Boolean);
  return `${STATUS_GLYPH[task.status] ?? G.todo} ${esc(clip(task.title, 70))}${priorityGlyph(task.priority)}${meta.length ? ` ${G.dot} ${meta.join(` ${G.dot} `)}` : ''}`;
}

// ---------- list ----------

const VIEW_TITLE: Record<ViewKey, () => string> = {
  my: () => t('task.view.my'),
  ours: () => t('task.view.ours'),
  today: () => t('task.view.today'),
  week: () => t('task.view.week'),
  overdue: () => t('task.view.overdue'),
  rec: () => t('task.view.rec'),
};

export function recurrenceLabel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const r: unknown = JSON.parse(raw);
    return isRecurrence(r) ? describeRecurrence(r) : null;
  } catch {
    return null;
  }
}

export function listView(state: ListState, items: TaskView[], total: number, pageSize: number, l: Lookup): View {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filter = stateToFilter(state);
  const singleProject = filter.projectId !== null;
  const showOwner = filter.owner !== 'me';
  const st = encState(state);

  const statusWord = t(`task.filter.status.${state.s}`).toLowerCase();
  const header = `${b(VIEW_TITLE[state.v]())} ${i(`${G.dot} ${total} ${statusWord}`)}`;

  const rows = items.map((task, idx) => {
    const n = state.pg * pageSize + idx + 1;
    const meta = [
      singleProject ? null : code(task.project_code),
      task.area_name ? esc(task.area_name) : null,
      dueLabel(task, l),
      showOwner ? (task.owner_name ? esc(task.owner_name) : i(t('task.unassigned'))) : null,
    ].filter(Boolean);
    const glyph = STATUS_GLYPH[task.status] ?? G.todo;
    return `${glyph} ${b(String(n))}  ${esc(clip(task.title, 80))}${priorityGlyph(task.priority)}\n      ${meta.join(` ${G.dot} `) || i(t('task.no_details'))}`;
  });

  const body = rows.length ? rows.join('\n') : t('task.empty', { view: state.v });
  const numberButtons = grid(
    items.map((task, idx) => ({ text: String(state.pg * pageSize + idx + 1), data: cb('t', 'o', enc(task.id), st) })),
    4,
  );

  const nav: Btn[] = [];
  if (pages > 1) {
    nav.push({ text: G.prev, data: cb('tl', encState({ ...state, pg: Math.max(0, state.pg - 1) })) });
    nav.push({ text: `${state.pg + 1}/${pages}`, data: cb('tl', st) });
    nav.push({ text: G.next, data: cb('tl', encState({ ...state, pg: Math.min(pages - 1, state.pg + 1) })) });
  }

  // Filter buttons: each one cycles to the next value.
  const ownerCycle = ['m', 'a', ...l.members.filter((m) => m.userId !== l.meUserId).map((m) => enc(m.userId))];
  const nextOwner = ownerCycle[(ownerCycle.indexOf(state.o) + 1) % ownerCycle.length] ?? 'm';
  const projectCycle = ['a', ...l.projects.map((p) => enc(p.id))];
  const nextProject = projectCycle[(projectCycle.indexOf(state.pj) + 1) % projectCycle.length] ?? 'a';
  const statusCycle: ListState['s'][] = ['o', 'b', 'd', 'a'];
  const nextStatus = statusCycle[(statusCycle.indexOf(state.s) + 1) % statusCycle.length]!;

  const ownerName =
    state.o === 'm' ? t('task.filter.me') : state.o === 'a' ? t('task.filter.everyone') : (l.members.find((m) => enc(m.userId) === state.o)?.name ?? '?');
  const projectName = state.pj === 'a' ? t('task.filter.all_projects') : (l.projects.find((p) => enc(p.id) === state.pj)?.code ?? '?');

  const filters: Btn[] = [
    { text: `${G.owner} ${ownerName}`, data: cb('tl', encState({ ...state, pg: 0, o: nextOwner })) },
    { text: `${G.project} ${projectName}`, data: cb('tl', encState({ ...state, pg: 0, pj: nextProject })) },
    { text: t(`task.filter.status.${state.s}`), data: cb('tl', encState({ ...state, pg: 0, s: nextStatus })) },
  ];

  return {
    text: `${header}\n${RULE}\n${body}`,
    keyboard: [
      ...numberButtons,
      nav,
      filters,
      [
        { text: t('task.btn_add'), data: cb('t', 'new', '0', st), style: 'primary' },
        { text: t('common.menu'), data: cb('m', 'menu') },
      ],
    ],
  };
}

// ---------- card ----------

export function cardView(task: TaskView, l: Lookup, st: string, banner?: string): View {
  const id = enc(task.id);
  const head = [code(task.project_code), task.area_name ? esc(task.area_name) : null, i(taskRef(task.id))].filter(Boolean).join(` ${G.dot} `);
  const due = dueLabel(task, l);
  const lines = [
    banner ? `${i(banner)}\n` : '',
    `${b(esc(task.title))}`,
    head,
    '',
    `${STATUS_GLYPH[task.status]} ${statusLabel(task.status)}  ${G.dot}  ${task.priority === 'high' ? `${G.high} ` : ''}${priorityLabel(task.priority)}`,
    `${G.owner} ${task.owner_name ? esc(task.owner_name) : i(t('task.unassigned'))}`,
    `${G.due} ${due ?? i(t('task.no_due'))}`,
    recurrenceLabel(task.recurrence) ? `${G.repeat} ${esc(recurrenceLabel(task.recurrence)!)}` : '',
    task.notes ? `\n${quote(esc(clip(task.notes, 2500)), task.notes.length > 200)}` : '',
    task.deleted_at ? `\n${i(t('task.is_deleted'))}` : '',
  ];
  const text = lines.filter((x) => x !== '').join('\n');

  const rows: Btn[][] = [];
  if (task.deleted_at) {
    rows.push([{ text: t('task.btn_restore'), data: cb('t', 'u', id, st), style: 'primary' }]);
  } else if (task.status === 'done') {
    rows.push([
      { text: t('task.btn_reopen'), data: cb('t', 'r', id, st) },
      { text: t('task.btn_history'), data: cb('t', 'h', id, st) },
    ]);
    rows.push([{ text: t('task.btn_delete'), data: cb('t', 'x', id, st) }]);
  } else {
    rows.push([
      { text: t('task.btn_done'), data: cb('t', 'd', id, st), style: 'success' },
      { text: t('task.btn_snooze'), data: cb('t', 'z', id, st) },
      { text: t('task.btn_edit'), data: cb('t', 'e', id, st) },
    ]);
    rows.push([
      { text: t('task.btn_reassign'), data: cb('t', 'a', id, st) },
      { text: t('task.btn_history'), data: cb('t', 'h', id, st) },
      { text: t('task.btn_delete'), data: cb('t', 'x', id, st) },
    ]);
  }
  if (st !== NO_STATE) rows.push([{ text: G.back, data: cb('tl', st) }]);
  return { text, keyboard: rows };
}

export function addedView(task: TaskView, l: Lookup, linkLabel?: string): View {
  const v = cardView(task, l, NO_STATE, `${G.ok} ${linkLabel ? t('task.added_linked', { label: linkLabel }) : t('task.added')}`);
  v.keyboard = [
    [
      { text: t('task.btn_undo_add'), data: cb('t', 'xu', enc(task.id), NO_STATE) },
      { text: t('task.btn_edit'), data: cb('t', 'e', enc(task.id), NO_STATE) },
      { text: t('task.btn_my'), data: cb('m', 'my') },
    ],
  ];
  return v;
}

export function snoozeView(task: TaskView, st: string): View {
  const id = enc(task.id);
  return {
    text: t('task.snooze_title', { title: task.title }),
    keyboard: [
      [
        { text: t('task.snooze.1h'), data: cb('t', 'zz', id, st, '1h') },
        { text: t('task.snooze.3h'), data: cb('t', 'zz', id, st, '3h') },
      ],
      [
        { text: t('task.snooze.tom'), data: cb('t', 'zz', id, st, 'tom') },
        { text: t('task.snooze.nw'), data: cb('t', 'zz', id, st, 'nw') },
      ],
      [{ text: G.back, data: cb('t', 'o', id, st) }],
    ],
  };
}

export function editView(task: TaskView, st: string): View {
  const id = enc(task.id);
  return {
    text: t('task.edit_title', { title: task.title }),
    keyboard: [
      [
        { text: t('task.edit.title'), data: cb('t', 'et', id, st) },
        { text: t('task.edit.notes'), data: cb('t', 'en', id, st) },
        { text: t('task.edit.due'), data: cb('t', 'ed', id, st) },
      ],
      [{ text: t('task.edit.repeat'), data: cb('t', 'er', id, st) }],
      [
        { text: t('task.edit.priority'), data: cb('t', 'ep', id, st) },
        { text: t('task.edit.status'), data: cb('t', 'es', id, st) },
      ],
      [
        { text: t('task.edit.area'), data: cb('t', 'ea', id, st) },
        { text: t('task.edit.project'), data: cb('t', 'ej', id, st) },
      ],
      [{ text: G.back, data: cb('t', 'o', id, st) }],
    ],
  };
}

export function choiceView(title: string, options: { label: string; data: string; selected: boolean }[], back: string, perRow = 2): View {
  return {
    text: title,
    keyboard: [
      ...grid(
        options.map((o) => ({ text: o.selected ? `${G.done} ${o.label}` : o.label, data: o.data, ...(o.selected ? { style: 'primary' as const } : {}) })),
        perRow,
      ),
      [{ text: G.back, data: back }],
    ],
  };
}

export function dueEditView(task: TaskView, st: string): View {
  const id = enc(task.id);
  return {
    text: t('task.due_prompt', { title: task.title }),
    keyboard: [
      [
        { text: t('task.due.today'), data: cb('t', 'dq', id, st, 'today') },
        { text: t('task.due.tom'), data: cb('t', 'dq', id, st, 'tom') },
        { text: t('task.due.nw'), data: cb('t', 'dq', id, st, 'nw') },
      ],
      [{ text: t('task.due.clear'), data: cb('t', 'dq', id, st, 'clr') }],
      [{ text: G.back, data: cb('t', 'o', id, st) }],
    ],
  };
}

export function deleteConfirmView(task: TaskView, st: string): View {
  const id = enc(task.id);
  return {
    text: t('task.delete_confirm', { title: task.title, ref: taskRef(task.id) }),
    keyboard: [[
      { text: t('task.btn_delete_yes'), data: cb('t', 'xx', id, st), style: 'danger' },
      { text: t('common.cancel'), data: cb('t', 'o', id, st) },
    ]],
  };
}

export function historyView(task: TaskView, events: EventRow[], l: Lookup, st: string): View {
  const name = (id: unknown) => (typeof id === 'number' ? (l.members.find((m) => m.userId === id)?.name ?? '?') : t('task.unassigned'));
  const lines = events.map((e) => {
    const who = esc(name(e.actor_user_id));
    const when = fmtStamp(fromDb(e.created_at), l.fmt);
    const data = JSON.parse(e.data) as { changes?: Record<string, { from: unknown; to: unknown }> };
    let what: string;
    if (e.action === 'task.updated' && data.changes) {
      what = Object.entries(data.changes)
        .map(([field, c]) => {
          switch (field) {
            case 'status': return t('task.hist.status', { to: statusLabel(c.to as TaskStatus) });
            case 'priority': return t('task.hist.priority', { to: priorityLabel(c.to as Priority) });
            case 'owner': return t('task.hist.owner', { to: name(c.to) });
            case 'due': return t('task.hist.due', { to: c.to ? String(c.to) : t('task.no_due') });
            case 'project': return t('task.hist.project', { to: l.projects.find((p) => p.id === c.to)?.code ?? '?' });
            case 'area': return t('task.hist.area', { to: c.to ? (l.areas.get(c.to as number) ?? '?') : '—' });
            case 'title': return t('task.hist.title');
            case 'notes': return t('task.hist.notes');
            default: return field;
          }
        })
        .join(', ');
    } else {
      what = t(`task.hist.${e.action.replace('task.', '') as 'created' | 'deleted' | 'restored'}`);
    }
    return `${i(when)} ${G.dot} ${who} ${G.dot} ${what}`;
  });
  return {
    text: `${b(t('task.history_title', { ref: taskRef(task.id) }))}\n${esc(clip(task.title, 80))}\n${RULE}\n${lines.join('\n') || i(t('task.history_empty'))}`,
    keyboard: [[{ text: G.back, data: cb('t', 'o', enc(task.id), st) }]],
  };
}

// ---------- quick-add draft ----------

const PRIORITY_CYCLE: readonly Priority[] = ['low', 'normal', 'high'];

export interface DraftPayload {
  title: string;
  projectId: number;
  ownerUserId: number | null;
  priority: Priority;
  areaId: number | null;
  due: Due | null;
  recurrence?: Recurrence | null;
  issues: Issue[];
  fromPlainText: boolean;
  /** Created in the context of e.g. a live meeting (becomes its action item). */
  link?: { type: string; id: number; label: string } | null;
}

export function issueText(issue: Issue): string {
  switch (issue.kind) {
    case 'unknown_owner': return t('qa.issue.unknown_owner', { value: issue.value });
    case 'unknown_tag': return t('qa.issue.unknown_tag', { value: issue.value });
    case 'unknown_priority': return t('qa.issue.unknown_priority', { value: issue.value });
    case 'multiple_projects': return t('qa.issue.multiple_projects');
    case 'multiple_dates': return t('qa.issue.multiple_dates');
    case 'vague_date': return t('qa.issue.vague_date', { value: issue.value });
    case 'past_date': return t('qa.issue.past_date');
    case 'empty_title': return t('qa.issue.empty_title');
  }
}

export function draftView(draftId: number, d: DraftPayload, l: Lookup): View {
  const id = enc(draftId);
  const project = l.projects.find((p) => p.id === d.projectId);
  // Cycle buttons carry the value they switch TO, so a double tap is harmless.
  const pIdx = l.projects.findIndex((p) => p.id === d.projectId);
  const nextProject = l.projects[(pIdx + 1) % l.projects.length];
  const owners = [...l.members.map((m) => m.userId), null];
  const nextOwner = owners[(owners.indexOf(d.ownerUserId) + 1) % owners.length] ?? null;
  const nextPriority = PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(d.priority) + 1) % PRIORITY_CYCLE.length]!;
  const owner = l.members.find((m) => m.userId === d.ownerUserId)?.name ?? t('task.unassigned');
  const due = draftDueLabel(d.due, l);
  const meta = [
    `${G.owner} ${esc(owner)}`,
    `${G.due} ${due ?? t('task.no_due')}`,
    d.priority !== 'normal' ? `${d.priority === 'high' ? G.high : G.low} ${priorityLabel(d.priority)}` : null,
    d.recurrence ? `${G.repeat} ${esc(describeRecurrence(d.recurrence))}` : null,
  ].filter(Boolean);
  const issues = d.issues.map(issueText);
  const text = [
    `${G.sparkle} ${b(d.link ? t('qa.title_linked', { label: d.link.label }) : d.fromPlainText ? t('qa.title_plain') : t('qa.title'))}`,
    RULE,
    b(esc(d.title || '—')),
    [project ? code(project.code) : '', d.areaId ? esc(l.areas.get(d.areaId) ?? '') : ''].filter(Boolean).join(` ${G.dot} `),
    meta.join(`  ${G.dot}  `),
    issues.length ? `\n${quote(issues.map((x) => `${G.warn} ${x}`).join('\n'))}` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
  return {
    text,
    keyboard: [
      [
        { text: t('qa.btn_save'), data: cb('qa', 's', id), style: 'success' },
        { text: t('common.cancel'), data: cb('qa', 'c', id) },
      ],
      [
        { text: `${G.project} ${project?.code ?? '?'} ›`, data: cb('qa', 'p', id, nextProject ? enc(nextProject.id) : '0') },
        { text: `${G.owner} ${owner} ›`, data: cb('qa', 'o', id, nextOwner === null ? '0' : enc(nextOwner)) },
        { text: `${priorityLabel(d.priority)} ›`, data: cb('qa', 'r', id, nextPriority) },
      ],
      d.due && !d.recurrence ? [{ text: t('qa.btn_clear_due'), data: cb('qa', 'd', id) }] : [],
      d.recurrence ? [{ text: t('qa.btn_no_repeat'), data: cb('qa', 'nr', id) }] : [],
    ],
  };
}
