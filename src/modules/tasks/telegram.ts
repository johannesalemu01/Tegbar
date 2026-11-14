import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { Actor } from '../../core/services/context.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { projectOverride, timeFormat } from '../../core/telegram/helpers.js';
import { show } from '../../core/telegram/render.js';
import { localDate } from '../../core/time.js';
import { b, esc, i } from '../../core/ui/html.js';
import { cb } from '../../core/ui/keyboard.js';
import { G } from '../../core/ui/theme.js';
import { buildLookup } from './lookup.js';
import { extractDue, isAmbiguous, type Due } from './quickadd.js';
import { parseRecurrence, withAnchor, type RecurrenceRule } from './recurrence.js';
import { DateTime } from 'luxon';
import { PRIORITIES, TASK_STATUSES } from './schema.js';
import type { SnoozeOption, TaskView } from './service.js';
import {
  NO_STATE, addedView, cardView, choiceView, decState, defaultState, deleteConfirmView, draftView, dueEditView,
  dueLabel, editView, encState, historyView, listView, recurrenceLabel, snoozeView, stateToFilter, taskRef,
  type DraftPayload, type ListState, type Lookup, type ViewKey,
} from './views.js';

const PAGE_SIZE = 8;
const DRAFT_KIND = 'task.quickadd';

function lookup(ctx: MemberCtx): Promise<Lookup> {
  return buildLookup(ctx.app, ctx.actor);
}

async function showList(ctx: MemberCtx, state: ListState): Promise<void> {
  const { items, total } = await ctx.app.tasks.list(ctx.actor, stateToFilter(state), state.pg, PAGE_SIZE);
  if (items.length === 0 && state.pg > 0) return showList(ctx, { ...state, pg: 0 }); // stale page after changes
  await show(ctx, listView(state, items, total, PAGE_SIZE, await lookup(ctx)));
}

async function showCard(ctx: MemberCtx, task: TaskView, st: string, banner?: string, mode: 'auto' | 'new' = 'auto'): Promise<void> {
  await show(ctx, cardView(task, await lookup(ctx), st, banner), mode);
}

/** Tell the new owner when someone else hands them a task (respects their quiet hours / DND). */
async function notifyAssignee(ctx: MemberCtx, task: TaskView): Promise<void> {
  if (!task.owner_user_id || task.owner_user_id === ctx.actor.userId) return;
  const ownerActor: Actor = { userId: task.owner_user_id, workspaceId: ctx.actor.workspaceId };
  const view = cardView(task, await buildLookup(ctx.app, ownerActor), NO_STATE, t('task.assigned_to_you', { name: ctx.member.display_name }));
  await ctx.notifier.deliver(ctx.actor.workspaceId, task.owner_user_id, view, 'direct');
}

function parseTaskRef(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^[Tt#]?(\d{1,9})$/.exec(s.trim());
  return m ? Number(m[1]) : null;
}

// ---------- quick add ----------

async function startQuickAdd(ctx: MemberCtx, text: string, fromPlainText: boolean): Promise<void> {
  const { app, actor } = ctx;
  const r = await app.tasks.parse(actor, text);
  if (!fromPlainText && !isAmbiguous(r)) {
    const task = await app.tasks.create(actor, {
      projectId: r.projectId, title: r.title, ownerUserId: r.ownerUserId, priority: r.priority, areaId: r.areaId, due: r.due,
      recurrence: r.recurrence,
    });
    await show(ctx, addedView(task, await lookup(ctx)), 'new');
    await notifyAssignee(ctx, task);
    return;
  }
  const payload: DraftPayload = {
    title: r.title, projectId: r.projectId, ownerUserId: r.ownerUserId, priority: r.priority,
    areaId: r.areaId, due: r.due, recurrence: r.recurrence, issues: r.issues, fromPlainText,
  };
  const id = await app.drafts.create(actor.workspaceId, actor.userId, DRAFT_KIND, payload);
  await show(ctx, draftView(id, payload, await lookup(ctx)), 'new');
}

/** Quick due buttons set a date only; send text (e.g. "friday 5pm") for a time. */
function quickDue(opt: string, ctx: MemberCtx): Due | null {
  const now = ctx.app.clock.now();
  const time = null;
  switch (opt) {
    case 'today': return { date: localDate(now), time };
    case 'tom': return { date: localDate(now.plus({ days: 1 })), time };
    case 'nw': return { date: localDate(now.plus({ weeks: 1 }).startOf('week')), time };
    default: return null;
  }
}

function parseDueText(ctx: MemberCtx, text: string): Due | null | 'clear' {
  if (/^\s*(-|none|clear|no date|remove)\s*$/i.test(text)) return 'clear';
  const r = extractDue(text, ctx.app.clock.now());
  return r.due;
}

// ---------- module ----------

export const tasksModule: TegbarModule = {
  name: 'tasks',
  telegram({ reg }) {
    const viewCommand = (view: ViewKey, description: Parameters<typeof reg.command>[0]['description'], name: string = view) =>
      reg.command({
        name, group: 'tasks', description,
        handler: async (ctx, args) => {
          const current = await ctx.app.projects.current(ctx.actor);
          const { project, unknown } = await projectOverride(ctx.app, ctx.actor, args);
          if (unknown) throw new DomainError('project.unknown_code', { code: unknown });
          await showList(ctx, defaultState(view, current.id, project?.id));
        },
      });

    reg.command({
      name: 'add', group: 'tasks', description: 'cmd.add',
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'task.add', {});
          return show(ctx, { text: t('task.add_prompt') });
        }
        await startQuickAdd(ctx, args, false);
      },
    });
    viewCommand('my', 'cmd.my');
    viewCommand('ours', 'cmd.ours');
    viewCommand('today', 'cmd.today');
    viewCommand('week', 'cmd.week');
    viewCommand('overdue', 'cmd.overdue');
    viewCommand('rec', 'cmd.recurring', 'recurring');

    reg.command({
      name: 'task', group: 'tasks', description: 'cmd.task',
      handler: async (ctx, args) => {
        const id = parseTaskRef(args.split(/\s+/)[0]);
        if (!id) throw new DomainError('task.ref_usage');
        await showCard(ctx, await ctx.app.tasks.get(ctx.actor, id, { includeDeleted: true }), NO_STATE);
      },
    });
    reg.command({
      name: 'assign', group: 'tasks', description: 'cmd.assign',
      handler: async (ctx, args) => {
        const [ref, who] = args.split(/\s+/);
        const id = parseTaskRef(ref);
        if (!id || !who) throw new DomainError('task.assign_usage');
        const qa = await ctx.app.tasks.quickAddContext(ctx.actor);
        const h = who.replace(/^@/, '').toLowerCase();
        const owner =
          h === 'me' ? ctx.actor.userId
          : ['partner', 'friend', 'other'].includes(h) ? (qa.members.length === 2 ? qa.members.find((m) => m.userId !== ctx.actor.userId)?.userId : undefined)
          : qa.members.find((m) => m.handles.includes(h))?.userId;
        if (!owner) throw new DomainError('task.unknown_person', { value: who });
        const { task, changed } = await ctx.app.tasks.update(ctx.actor, id, { ownerUserId: owner });
        await showCard(ctx, task, NO_STATE, changed ? t('task.reassigned') : t('common.nothing_changed'));
        if (changed) await notifyAssignee(ctx, task);
      },
    });
    reg.command({
      name: 'due', group: 'tasks', description: 'cmd.due',
      handler: async (ctx, args) => {
        const [ref, ...rest] = args.split(/\s+/);
        const id = parseTaskRef(ref);
        if (!id || rest.length === 0) throw new DomainError('task.due_usage');
        const due = parseDueText(ctx, rest.join(' '));
        if (due === null) throw new DomainError('task.due_unparsed');
        const { task } = await ctx.app.tasks.update(ctx.actor, id, { due: due === 'clear' ? null : due });
        await showCard(ctx, task, NO_STATE, t('common.saved'));
      },
    });
    reg.command({
      name: 'undo', group: 'tasks', description: 'cmd.undo',
      handler: async (ctx) => {
        const task = await ctx.app.tasks.undoLastDelete(ctx.actor);
        if (!task) return show(ctx, { text: t('task.undo_nothing') });
        await showCard(ctx, task, NO_STATE, t('task.restored'));
      },
    });

    reg.menuEntry({ label: 'menu.add', command: 'add', order: 0 });
    reg.menuEntry({ label: 'menu.my', command: 'my', order: 10 });
    reg.menuEntry({ label: 'menu.today', command: 'today', order: 20 });
    reg.menuEntry({ label: 'menu.week', command: 'week', order: 25 });
    reg.menuEntry({ label: 'menu.overdue', command: 'overdue', order: 30 });
    reg.menuEntry({ label: 'menu.ours', command: 'ours', order: 40 });

    // Lists
    reg.callback('tl', async (ctx, [raw], answer) => {
      const state = decState(raw);
      if (!state) return answer(t('common.stale'), true);
      await showList(ctx, state);
    });

    // Task card actions: t:<action>:<id>:<state>[:<extra>]
    reg.callback('t', async (ctx, [action, rawId, rawState, extra], answer) => {
      const { app, actor } = ctx;
      const st = decState(rawState) ? rawState! : NO_STATE;
      if (action === 'new') {
        await app.pending.set(actor.workspaceId, actor.userId, 'task.add', {});
        return show(ctx, { text: t('task.add_prompt') }, 'new');
      }
      const id = dec(rawId);
      if (!id) return answer(t('common.stale'), true);
      const card = async (task: TaskView, banner?: string) => showCard(ctx, task, st, banner);

      switch (action) {
        case 'o':
          return card(await app.tasks.get(actor, id, { includeDeleted: true }));
        case 'd': {
          const { task, changed, spawned } = await app.tasks.setStatus(actor, id, 'done');
          await answer(changed ? t('task.done_toast') : t('task.already_done'));
          const next = spawned ? ` ${G.dot} ${t('task.next_occurrence', { when: dueLabel(spawned, await lookup(ctx)) ?? '' })}` : '';
          return card(task, changed ? `${G.ok} ${t('task.done_banner')}${next}` : undefined);
        }
        case 'er': {
          const task = await app.tasks.get(actor, id);
          if (extra) {
            const anchor = task.due_date ?? localDate(app.clock.now());
            const a = DateTime.fromISO(anchor);
            const rules: Record<string, RecurrenceRule | null> = {
              daily: { freq: 'daily', interval: 1 },
              wd: { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] },
              wk: { freq: 'weekly', interval: 1, weekdays: [a.weekday] },
              mo: { freq: 'monthly', interval: 1, day: a.day },
              off: null,
            };
            if (!(extra in rules)) return answer(t('common.stale'), true);
            const rule = rules[extra]!;
            return card((await app.tasks.update(actor, id, { recurrence: rule ? withAnchor(rule, anchor) : null })).task, t('common.saved'));
          }
          await app.pending.set(actor.workspaceId, actor.userId, 'task.repeat', { id, st });
          const opt = (k: string) => cb('t', 'er', rawId!, st, k);
          return show(ctx, {
            text: t('task.repeat_prompt', { title: task.title, current: recurrenceLabel(task.recurrence) ?? t('common.off') }),
            keyboard: [
              [{ text: t('task.repeat.daily'), data: opt('daily') }, { text: t('task.repeat.wd'), data: opt('wd') }],
              [{ text: t('task.repeat.wk'), data: opt('wk') }, { text: t('task.repeat.mo'), data: opt('mo') }],
              [{ text: t('task.repeat.off'), data: opt('off') }, { text: G.back, data: cb('t', 'o', rawId!, st) }],
            ],
          });
        }
        case 'r': {
          const { task, changed } = await app.tasks.setStatus(actor, id, 'todo');
          await answer(changed ? t('task.reopened') : t('common.nothing_changed'));
          return card(task);
        }
        case 'z':
          return show(ctx, snoozeView(await app.tasks.get(actor, id), st));
        case 'zz': {
          if (!['1h', '3h', 'tom', 'nw'].includes(extra ?? '')) return answer(t('common.stale'), true);
          const { task } = await app.tasks.snooze(actor, id, extra as SnoozeOption);
          await answer(t('task.snoozed'));
          return card(task);
        }
        case 'e':
          return show(ctx, editView(await app.tasks.get(actor, id), st));
        case 'et':
        case 'en': {
          const task = await app.tasks.get(actor, id);
          await app.pending.set(actor.workspaceId, actor.userId, action === 'et' ? 'task.title' : 'task.notes', { id, st });
          return show(ctx, { text: t(action === 'et' ? 'task.title_prompt' : 'task.notes_prompt', { title: task.title }) }, 'new');
        }
        case 'ed': {
          const task = await app.tasks.get(actor, id);
          await app.pending.set(actor.workspaceId, actor.userId, 'task.due', { id, st });
          return show(ctx, dueEditView(task, st));
        }
        case 'dq': {
          await app.pending.clear(actor.workspaceId, actor.userId);
          const due = extra === 'clr' ? null : quickDue(extra ?? '', ctx);
          if (extra !== 'clr' && !due) return answer(t('common.stale'), true);
          const { task } = await app.tasks.update(actor, id, { due });
          return card(task, t('common.saved'));
        }
        case 'ep': {
          const task = await app.tasks.get(actor, id);
          if (extra) {
            if (!PRIORITIES.includes(extra as never)) return answer(t('common.stale'), true);
            return card((await app.tasks.update(actor, id, { priority: extra as TaskView['priority'] })).task);
          }
          return show(ctx, choiceView(t('task.choose_priority'), PRIORITIES.map((p) => ({
            label: t(`task.priority.${p}`), data: cb('t', 'ep', rawId!, st, p), selected: task.priority === p,
          })), cb('t', 'e', rawId!, st), 3));
        }
        case 'es': {
          const task = await app.tasks.get(actor, id);
          if (extra) {
            if (!TASK_STATUSES.includes(extra as never)) return answer(t('common.stale'), true);
            return card((await app.tasks.update(actor, id, { status: extra as TaskView['status'] })).task);
          }
          return show(ctx, choiceView(t('task.choose_status'), TASK_STATUSES.map((s) => ({
            label: t(`task.status.${s}`), data: cb('t', 'es', rawId!, st, s), selected: task.status === s,
          })), cb('t', 'e', rawId!, st)));
        }
        case 'ea': {
          const task = await app.tasks.get(actor, id);
          if (extra !== undefined) {
            const areaId = extra === '0' ? null : dec(extra);
            if (extra !== '0' && !areaId) return answer(t('common.stale'), true);
            return card((await app.tasks.update(actor, id, { areaId })).task);
          }
          const areas = await app.projects.areas(actor, task.project_id);
          return show(ctx, choiceView(t('task.choose_area'), [
            ...areas.map((a) => ({ label: a.name, data: cb('t', 'ea', rawId!, st, enc(a.id)), selected: task.area_id === a.id })),
            { label: t('task.no_area'), data: cb('t', 'ea', rawId!, st, '0'), selected: task.area_id === null },
          ], cb('t', 'e', rawId!, st)));
        }
        case 'ej': {
          const task = await app.tasks.get(actor, id);
          if (extra) {
            const projectId = dec(extra);
            if (!projectId) return answer(t('common.stale'), true);
            return card((await app.tasks.update(actor, id, { projectId })).task);
          }
          const projects = await app.projects.list(actor);
          return show(ctx, choiceView(t('task.choose_project'), projects.map((p) => ({
            label: p.code, data: cb('t', 'ej', rawId!, st, enc(p.id)), selected: task.project_id === p.id,
          })), cb('t', 'e', rawId!, st)));
        }
        case 'a': {
          const task = await app.tasks.get(actor, id);
          const members = await app.members.list(actor.workspaceId);
          return show(ctx, choiceView(t('task.choose_owner'), [
            ...members.map((m) => ({ label: m.display_name, data: cb('t', 'aa', rawId!, st, enc(m.user_id)), selected: task.owner_user_id === m.user_id })),
            { label: t('task.unassigned'), data: cb('t', 'aa', rawId!, st, '0'), selected: task.owner_user_id === null },
          ], cb('t', 'o', rawId!, st)));
        }
        case 'aa': {
          const ownerUserId = extra === '0' ? null : dec(extra);
          if (extra !== '0' && !ownerUserId) return answer(t('common.stale'), true);
          const { task, changed } = await app.tasks.update(actor, id, { ownerUserId });
          await answer(changed ? t('task.reassigned') : t('common.nothing_changed'));
          await card(task);
          if (changed) await notifyAssignee(ctx, task);
          return;
        }
        case 'x':
          return show(ctx, deleteConfirmView(await app.tasks.get(actor, id), st));
        case 'xx':
        case 'xu': {
          const { task, changed } = await app.tasks.remove(actor, id);
          await answer(changed ? t('task.deleted_toast') : t('task.already_deleted'));
          return card(task);
        }
        case 'u': {
          const { task, changed } = await app.tasks.restore(actor, id);
          await answer(changed ? t('task.restored') : t('common.nothing_changed'));
          return card(task, changed ? t('task.restored') : undefined);
        }
        case 'h': {
          const task = await app.tasks.get(actor, id, { includeDeleted: true });
          return show(ctx, historyView(task, await app.tasks.history(actor, id), await lookup(ctx), st));
        }
        default:
          return answer(t('common.stale'), true);
      }
    });

    // Quick-add draft card: qa:<action>:<draftId>
    reg.callback('qa', async (ctx, [action, rawId, value], answer) => {
      const { app, actor } = ctx;
      const draftId = dec(rawId);
      if (!draftId) return answer(t('common.stale'), true);
      const draft = await app.drafts.get<DraftPayload>(draftId, actor.userId, DRAFT_KIND);
      if (!draft) {
        await answer(t('qa.expired'), true);
        return show(ctx, { text: i(t('qa.expired')) });
      }
      if (draft.consumed) return answer(t('qa.already_handled'));
      const d = draft.payload;
      const l = await lookup(ctx);

      switch (action) {
        case 's': {
          if (!d.title) return answer(t('qa.issue.empty_title'), true);
          if (!(await app.drafts.consume(draftId, actor.userId))) return answer(t('qa.already_handled'));
          const task = await app.tasks.create(actor, {
            projectId: d.projectId, title: d.title, ownerUserId: d.ownerUserId, priority: d.priority, areaId: d.areaId, due: d.due,
            recurrence: d.recurrence ?? null,
          });
          await answer(t('task.added'));
          await show(ctx, addedView(task, l));
          await notifyAssignee(ctx, task);
          return;
        }
        case 'c':
          if (!(await app.drafts.consume(draftId, actor.userId))) return answer(t('qa.already_handled'));
          return show(ctx, { text: i(t('common.cancelled')) });
        case 'p': {
          const next = l.projects.find((p) => p.id === dec(value));
          if (!next) return answer(t('common.stale'), true);
          if (d.projectId === next.id) break;
          d.projectId = next.id;
          d.areaId = null;
          d.issues = d.issues.filter((x) => x.kind !== 'multiple_projects');
          break;
        }
        case 'o': {
          const owner = value === '0' ? null : l.members.find((m) => m.userId === dec(value))?.userId;
          if (owner === undefined) return answer(t('common.stale'), true);
          d.ownerUserId = owner;
          d.issues = d.issues.filter((x) => x.kind !== 'unknown_owner');
          break;
        }
        case 'r':
          if (!PRIORITIES.includes(value as never)) return answer(t('common.stale'), true);
          d.priority = value as DraftPayload['priority'];
          d.issues = d.issues.filter((x) => x.kind !== 'unknown_priority');
          break;
        case 'nr':
          d.recurrence = null;
          break;
        case 'd':
          d.due = null;
          d.issues = d.issues.filter((x) => !['multiple_dates', 'vague_date', 'past_date'].includes(x.kind));
          break;
        default:
          return answer(t('common.stale'), true);
      }
      if (!(await app.drafts.update(draftId, actor.userId, d))) return answer(t('qa.already_handled'));
      await show(ctx, draftView(draftId, d, l));
    });

    // Text inputs
    reg.input('task.add', async (ctx, text) => startQuickAdd(ctx, text, false));
    reg.input('task.repeat', async (ctx, text, p: { id: number; st: string }) => {
      const task = await ctx.app.tasks.get(ctx.actor, p.id);
      const anchor = task.due_date ?? localDate(ctx.app.clock.now());
      const found = parseRecurrence(text, DateTime.fromISO(anchor).weekday);
      if (!found) {
        await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'task.repeat', p);
        throw new DomainError('task.repeat_unparsed');
      }
      const { task: updated } = await ctx.app.tasks.update(ctx.actor, p.id, { recurrence: withAnchor(found.rule, anchor) });
      await showCard(ctx, updated, p.st, t('common.saved'));
    });
    reg.input('task.title', async (ctx, text, p: { id: number; st: string }) => {
      const { task } = await ctx.app.tasks.update(ctx.actor, p.id, { title: text });
      await showCard(ctx, task, p.st, t('common.saved'));
    });
    reg.input('task.notes', async (ctx, text, p: { id: number; st: string }) => {
      const notes = /^\s*-\s*$/.test(text) ? null : text;
      const { task } = await ctx.app.tasks.update(ctx.actor, p.id, { notes });
      await showCard(ctx, task, p.st, t('common.saved'));
    });
    reg.input('task.due', async (ctx, text, p: { id: number; st: string }) => {
      const due = parseDueText(ctx, text);
      if (due === null) {
        await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'task.due', p);
        throw new DomainError('task.due_unparsed');
      }
      const { task } = await ctx.app.tasks.update(ctx.actor, p.id, { due: due === 'clear' ? null : due });
      await showCard(ctx, task, p.st, t('common.saved'));
    });

    // Any other plain text becomes a "save as task?" card.
    reg.text(async (ctx, text) => {
      await startQuickAdd(ctx, text, true);
      return true;
    });

    // Dashboard section
    reg.dashboardSection({
      order: 10,
      render: async (ctx) => {
        const { app, actor } = ctx;
        const [stats, projects, people, members] = await Promise.all([
          app.tasks.stats(actor),
          app.projects.list(actor),
          app.tasks.personCounts(actor),
          app.members.list(actor.workspaceId),
        ]);
        const projectLines = projects.map((p) => {
          const s = stats.find((x) => x.projectId === p.id);
          if (!s || (s.open === 0 && s.doneThisWeek === 0)) return `${G.project} ${b(esc(p.name))} ${i(t('dash.quiet'))}`;
          const parts = [
            t('dash.open', { n: s.open }),
            s.doing ? t('dash.doing', { n: s.doing }) : null,
            s.blocked ? t('dash.blocked', { n: s.blocked }) : null,
            s.overdue ? b(t('dash.overdue', { n: s.overdue })) : null,
            s.doneThisWeek ? t('dash.done_week', { n: s.doneThisWeek }) : null,
          ].filter(Boolean);
          return `${G.project} ${b(esc(p.name))}\n      ${parts.join(` ${G.dot} `)}`;
        });
        const peopleLines = people.map((p) => {
          const name = members.find((m) => m.user_id === p.userId)?.display_name ?? '?';
          return `${G.owner} ${esc(name)} ${G.dot} ${t('dash.open', { n: p.open })}${p.overdue ? ` ${G.dot} ${b(t('dash.overdue', { n: p.overdue }))}` : ''}`;
        });
        return `${b(t('dash.tasks'))}\n${projectLines.join('\n')}\n\n${b(t('dash.people'))}\n${peopleLines.join('\n')}`;
      },
    });
  },
};

export { encState, taskRef };
