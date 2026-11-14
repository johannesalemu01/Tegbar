import type { DateTime } from 'luxon';
import type { App } from '../../app.js';
import { t } from '../../core/i18n/index.js';
import type { Actor } from '../../core/services/context.js';
import { fromDb, toDb } from '../../core/time.js';
import { b, code, esc, i } from '../../core/ui/html.js';
import { cb, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { enc } from '../../core/ids.js';
import { buildLookup } from '../tasks/lookup.js';
import type { TaskFilter, TaskView } from '../tasks/service.js';
import { NO_STATE, dueLabel, taskLine, taskRef, type Lookup } from '../tasks/views.js';

const MAX_LINES = 8;

const navButtons = (): Btn[][] => [[
  { text: t('menu.today'), data: cb('m', 'today') },
  { text: t('menu.overdue'), data: cb('m', 'overdue') },
  { text: t('menu.my'), data: cb('m', 'my') },
]];

async function section(app: App, actor: Actor, title: string, f: TaskFilter, l: Lookup, opts: { owner?: boolean } = {}): Promise<string | null> {
  const { items, total } = await app.tasks.list(actor, f, 0, MAX_LINES);
  if (total === 0) return null;
  const more = total > items.length ? `\n${i(t('digest.more', { n: total - items.length }))}` : '';
  return `${b(title)} ${i(`${G.dot} ${total}`)}\n${items.map((x) => taskLine(x, l, opts)).join('\n')}${more}`;
}

export async function dailyDigest(app: App, actor: Actor): Promise<View> {
  const l = await buildLookup(app, actor);
  const me = l.members.find((m) => m.userId === actor.userId)?.name ?? '';
  const parts = [
    await section(app, actor, t('digest.due_today'), { owner: 'me', projectId: null, status: 'open', due: 'today' }, l),
    await section(app, actor, t('digest.overdue'), { owner: 'me', projectId: null, status: 'open', due: 'overdue' }, l),
  ].filter(Boolean);
  const partners = [];
  for (const p of (await app.tasks.personCounts(actor)).filter((p) => p.userId !== actor.userId)) {
    const name = l.members.find((m) => m.userId === p.userId)?.name ?? '?';
    partners.push(`${G.owner} ${esc(name)} ${G.dot} ${t('dash.open', { n: p.open })}${p.overdue ? ` ${G.dot} ${t('dash.overdue', { n: p.overdue })}` : ''}`);
  }
  return {
    text: [
      `☀️ ${b(t('digest.morning', { name: me }))}  ${i(l.now.toFormat('cccc d LLL'))}`,
      RULE,
      parts.length ? parts.join('\n\n') : t('digest.clear_day'),
      partners.length ? `\n${partners.join('\n')}` : '',
    ].filter(Boolean).join('\n'),
    keyboard: navButtons(),
  };
}

export async function planDigest(app: App, actor: Actor): Promise<View> {
  const l = await buildLookup(app, actor);
  const parts = [
    await section(app, actor, t('digest.my_week'), { owner: 'me', projectId: null, status: 'open', due: 'week' }, l),
    await section(app, actor, t('digest.overdue'), { owner: 'me', projectId: null, status: 'open', due: 'overdue' }, l),
    await section(app, actor, t('digest.blocked_all'), { owner: 'all', projectId: null, status: 'blocked', due: 'any' }, l, { owner: true }),
  ].filter(Boolean);
  const unassigned = (await app.tasks.list(actor, { owner: 'all', projectId: null, status: 'open', due: 'any' }, 0, 200)).items.filter((x) => !x.owner_user_id);
  if (unassigned.length) parts.push(`${b(t('digest.unassigned'))} ${i(`${G.dot} ${unassigned.length}`)}\n${unassigned.slice(0, MAX_LINES).map((x) => taskLine(x, l)).join('\n')}`);
  return {
    text: [`▦ ${b(t('digest.plan_title'))}  ${i(weekRange(l.now))}`, RULE, parts.length ? parts.join('\n\n') : t('digest.empty_week')].join('\n'),
    keyboard: navButtons(),
  };
}

export async function reviewDigest(app: App, actor: Actor): Promise<View> {
  const l = await buildLookup(app, actor);
  const since = toDb(l.now.startOf('week'));
  const done: string[] = [];
  for (const m of l.members) {
    const r = await app.tasks.list(actor, { owner: m.userId, projectId: null, status: 'done', due: 'any', completedSince: since }, 0, 5);
    done.push(`${G.owner} ${b(esc(m.name))} ${G.dot} ${t('digest.done_n', { n: r.total })}${r.items.length ? `\n${r.items.map((x) => `   ${G.done} ${esc(x.title)}`).join('\n')}` : ''}`);
  }
  const parts = [
    `${b(t('digest.done_week'))}\n${done.join('\n')}`,
    await section(app, actor, t('digest.still_overdue'), { owner: 'all', projectId: null, status: 'open', due: 'overdue' }, l, { owner: true }),
    await section(app, actor, t('digest.blocked_all'), { owner: 'all', projectId: null, status: 'blocked', due: 'any' }, l, { owner: true }),
  ].filter(Boolean);
  return {
    text: [`✓ ${b(t('digest.review_title'))}  ${i(weekRange(l.now))}`, RULE, parts.join('\n\n')].join('\n'),
    keyboard: navButtons(),
  };
}

function weekRange(now: DateTime): string {
  const s = now.startOf('week');
  const e = s.plus({ days: 6 });
  return s.month === e.month ? `${s.toFormat('d')}–${e.toFormat('d LLL')}` : `${s.toFormat('d LLL')} – ${e.toFormat('d LLL')}`;
}

// ---------- task reminders ----------

function humanOffset(minutes: number): string {
  if (minutes % 1440 === 0) return t('rem.in_days', { n: minutes / 1440 });
  if (minutes % 60 === 0) return t('rem.in_hours', { n: minutes / 60 });
  return t('rem.in_minutes', { n: minutes });
}

export async function taskReminderView(
  app: App,
  owner: Actor,
  task: TaskView,
  kind: { type: 'before'; minutes: number } | { type: 'due' } | { type: 'overdue'; n: number; max: number },
  late: boolean,
): Promise<View> {
  const l = await buildLookup(app, owner);
  const head =
    kind.type === 'before' ? `⏰ ${b(t('rem.coming_up', { when: humanOffset(kind.minutes) }))}`
    : kind.type === 'due' ? `⏰ ${b(task.due_at ? t('rem.due_now') : t('rem.due_today'))}`
    : `⚑ ${b(t('rem.still_open'))} ${i(t('rem.nudge_n', { n: kind.n, max: kind.max }))}`;
  const meta = [code(task.project_code), task.area_name ? esc(task.area_name) : null, i(taskRef(task.id))].filter(Boolean).join(` ${G.dot} `);
  const id = enc(task.id);
  return {
    text: [head, '', b(esc(task.title)), meta, `${G.due} ${dueLabel(task, l, { plain: kind.type === 'due' }) ?? ''}`, late ? i(t('rem.late')) : ''].filter((x) => x !== '').join('\n'),
    keyboard: [[
      { text: t('task.btn_done'), data: cb('t', 'd', id, NO_STATE), style: 'success' },
      { text: t('task.btn_snooze'), data: cb('t', 'z', id, NO_STATE) },
      { text: t('rem.btn_open'), data: cb('t', 'o', id, NO_STATE) },
    ]],
  };
}

export function oneOffView(fromName: string, text: string, reminderId: number, toSelf: boolean, late: boolean, at: string): View {
  const id = enc(reminderId);
  return {
    text: [
      `🔔 ${b(t('rem.title'))}${toSelf ? '' : ` ${i(t('rem.from', { name: fromName }))}`}`,
      '',
      esc(text),
      late ? `\n${i(t('rem.late_since', { when: fromDb(at).toFormat('HH:mm') }))}` : '',
    ].filter((x) => x !== '').join('\n'),
    keyboard: [[
      { text: t('rem.btn_snooze1h'), data: cb('rm', 'z', id, '1h') },
      { text: t('rem.btn_tomorrow'), data: cb('rm', 'z', id, 'tom') },
      { text: t('rem.btn_ok'), data: cb('rm', 'ok', id), style: 'success' },
    ]],
  };
}

export type { TaskView };
