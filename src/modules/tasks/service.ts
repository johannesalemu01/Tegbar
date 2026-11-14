import { sql } from 'kysely';
import type { Db } from '../../core/db/database.js';
import { DomainError, NotFoundError } from '../../core/errors.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog, EventRow } from '../../core/services/events.js';
import type { Members } from '../../core/services/members.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Projects } from '../../core/services/projects.js';
import type { DateTime } from 'luxon';
import { atLocal, fromDb, fromLocalDate, localDate, toDb, type Clock } from '../../core/time.js';
import { parseQuickAdd, type Due, type QuickAddContext, type QuickAddResult } from './quickadd.js';
import { OPEN_STATUSES, PRIORITIES, TASK_STATUSES, type Priority, type TaskRow, type TaskStatus } from './schema.js';

export interface TaskInput {
  projectId: number;
  title: string;
  notes?: string | null;
  ownerUserId?: number | null;
  priority?: Priority;
  areaId?: number | null;
  due?: Due | null;
}

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  ownerUserId?: number | null;
  areaId?: number | null;
  projectId?: number;
  due?: Due | null;
}

export type OwnerFilter = 'me' | 'all' | number;
export type StatusFilter = 'open' | 'blocked' | 'done' | 'all';
export type DueFilter = 'any' | 'today' | 'week' | 'overdue';

export interface TaskFilter {
  owner: OwnerFilter;
  projectId: number | null; // null = every visible project
  status: StatusFilter;
  due: DueFilter;
  areaId?: number | null;
}

export interface TaskView extends TaskRow {
  project_code: string;
  project_name: string;
  area_name: string | null;
  owner_name: string | null;
}

export type SnoozeOption = '1h' | '3h' | 'tom' | 'nw';

export interface TaskStats {
  projectId: number;
  open: number;
  doing: number;
  blocked: number;
  overdue: number;
  doneThisWeek: number;
}

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly projects: Projects,
    private readonly members: Members,
  ) {}

  // ---------- queries ----------

  async get(actor: Actor, id: number, opts: { includeDeleted?: boolean } = {}): Promise<TaskView> {
    const row = await this.baseQuery().where('t.id', '=', id).where('t.workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!row || (row.deleted_at && !opts.includeDeleted)) throw new NotFoundError();
    await this.permissions.authorize(actor, 'task.view', { projectId: row.project_id });
    return row;
  }

  async list(actor: Actor, f: TaskFilter, page = 0, pageSize = 8): Promise<{ items: TaskView[]; total: number }> {
    const visible = await this.permissions.visibleProjectIds(actor);
    const projectIds = f.projectId === null ? visible : visible.filter((id) => id === f.projectId);
    if (projectIds.length === 0) return { items: [], total: 0 };

    const now = this.clock.now();
    const today = localDate(now);
    const nowIso = toDb(now);
    const weekEnd = localDate(now.plus({ days: 6 }));

    let q = this.baseQuery()
      .where('t.workspace_id', '=', actor.workspaceId)
      .where('t.deleted_at', 'is', null)
      .where('t.project_id', 'in', projectIds)
      .where('p.archived_at', 'is', null);

    if (f.owner === 'me') q = q.where('t.owner_user_id', '=', actor.userId);
    else if (typeof f.owner === 'number') q = q.where('t.owner_user_id', '=', f.owner);
    if (f.areaId) q = q.where('t.area_id', '=', f.areaId);

    if (f.status === 'open') q = q.where('t.status', 'in', [...OPEN_STATUSES]);
    else if (f.status === 'blocked') q = q.where('t.status', '=', 'blocked');
    else if (f.status === 'done') q = q.where('t.status', '=', 'done');

    if (f.due === 'today') q = q.where('t.due_date', '=', today);
    else if (f.due === 'week') q = q.where('t.due_date', '>=', today).where('t.due_date', '<=', weekEnd);
    else if (f.due === 'overdue') {
      q = q.where('t.status', '!=', 'done').where((eb) =>
        eb.or([
          eb.and([eb('t.due_at', 'is not', null), eb('t.due_at', '<', nowIso)]),
          eb.and([eb('t.due_at', 'is', null), eb('t.due_date', '<', today)]),
        ]),
      );
    }

    const countRow = await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    const total = Number(countRow?.n ?? 0);

    const items =
      f.status === 'done'
        ? await q.orderBy('t.completed_at', 'desc').orderBy('t.id', 'desc').limit(pageSize).offset(page * pageSize).execute()
        : await q
            .orderBy(sql`case when t.due_date is null then 1 else 0 end`)
            .orderBy('t.due_date')
            .orderBy(sql`coalesce(t.due_at, '9999')`)
            .orderBy(sql`case t.priority when 'high' then 0 when 'normal' then 1 else 2 end`)
            .orderBy('t.id')
            .limit(pageSize)
            .offset(page * pageSize)
            .execute();
    return { items, total };
  }

  async history(actor: Actor, id: number): Promise<EventRow[]> {
    await this.get(actor, id, { includeDeleted: true });
    return this.events.forEntity(this.db, actor.workspaceId, 'task', id, 15);
  }

  async stats(actor: Actor): Promise<TaskStats[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (visible.length === 0) return [];
    const now = this.clock.now();
    const today = localDate(now);
    const nowIso = toDb(now);
    const weekAgo = toDb(now.minus({ days: 7 }));
    const rows = await this.db
      .selectFrom('tasks')
      .select((eb) => [
        'project_id',
        eb.fn.sum<number>(sql`case when status != 'done' then 1 else 0 end`).as('open'),
        eb.fn.sum<number>(sql`case when status = 'doing' then 1 else 0 end`).as('doing'),
        eb.fn.sum<number>(sql`case when status = 'blocked' then 1 else 0 end`).as('blocked'),
        eb.fn
          .sum<number>(
            sql`case when status != 'done' and ((due_at is not null and due_at < ${nowIso}) or (due_at is null and due_date < ${today})) then 1 else 0 end`,
          )
          .as('overdue'),
        eb.fn.sum<number>(sql`case when status = 'done' and completed_at >= ${weekAgo} then 1 else 0 end`).as('done_week'),
      ])
      .where('workspace_id', '=', actor.workspaceId)
      .where('deleted_at', 'is', null)
      .where('project_id', 'in', visible)
      .groupBy('project_id')
      .execute();
    return rows.map((r) => ({
      projectId: r.project_id,
      open: Number(r.open ?? 0),
      doing: Number(r.doing ?? 0),
      blocked: Number(r.blocked ?? 0),
      overdue: Number(r.overdue ?? 0),
      doneThisWeek: Number(r.done_week ?? 0),
    }));
  }

  /** Per-person open/overdue counts across visible projects (facts only). */
  async personCounts(actor: Actor): Promise<{ userId: number; open: number; overdue: number }[]> {
    const members = await this.members.list(actor.workspaceId);
    const out = [];
    for (const m of members) {
      const open = await this.list(actor, { owner: m.user_id, projectId: null, status: 'open', due: 'any' }, 0, 1);
      const overdue = await this.list(actor, { owner: m.user_id, projectId: null, status: 'open', due: 'overdue' }, 0, 1);
      out.push({ userId: m.user_id, open: open.total, overdue: overdue.total });
    }
    return out;
  }

  // ---------- quick add ----------

  async quickAddContext(actor: Actor, defaultProjectId?: number): Promise<QuickAddContext> {
    const [members, projects, current] = await Promise.all([
      this.members.list(actor.workspaceId),
      this.projects.list(actor),
      defaultProjectId ? Promise.resolve(null) : this.projects.current(actor),
    ]);
    const areasByProject = new Map<number, { id: number; slug: string }[]>();
    for (const p of projects) {
      areasByProject.set(p.id, (await this.projects.areas(actor, p.id)).map((a) => ({ id: a.id, slug: a.slug })));
    }
    const userRows = members.length
      ? await this.db.selectFrom('users').select(['id', 'username', 'first_name']).where('id', 'in', members.map((m) => m.user_id)).execute()
      : [];
    return {
      now: this.clock.now(),
      meUserId: actor.userId,
      members: members.map((m) => {
        const u = userRows.find((r) => r.id === m.user_id);
        const handles = [m.handle, m.display_name.toLowerCase(), u?.username?.toLowerCase(), u?.first_name.toLowerCase()];
        return { userId: m.user_id, handles: [...new Set(handles.filter((h): h is string => !!h))] };
      }),
      projects: projects.map((p) => ({ id: p.id, code: p.code })),
      areasByProject,
      defaultProjectId: defaultProjectId ?? current!.id,
    };
  }

  async parse(actor: Actor, text: string): Promise<QuickAddResult> {
    return parseQuickAdd(text, await this.quickAddContext(actor));
  }

  // ---------- commands ----------

  async create(actor: Actor, input: TaskInput): Promise<TaskView> {
    await this.permissions.authorize(actor, 'task.create', { projectId: input.projectId });
    const title = this.cleanTitle(input.title);
    const ownerUserId = input.ownerUserId === undefined ? actor.userId : input.ownerUserId;
    await this.assertOwner(actor, ownerUserId, input.projectId);
    const areaId = await this.checkArea(input.areaId ?? null, input.projectId);
    const priority = input.priority ?? 'normal';
    if (!PRIORITIES.includes(priority)) throw new DomainError('task.bad_priority');
    const now = toDb(this.clock.now());
    const due = this.dueColumns(input.due ?? null);

    const id = await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('tasks')
        .values({
          workspace_id: actor.workspaceId, project_id: input.projectId, area_id: areaId, title,
          notes: input.notes?.trim() || null, status: 'todo', priority, owner_user_id: ownerUserId,
          created_by: actor.userId, ...due, completed_at: null, deleted_at: null, deleted_by: null,
          created_at: now, updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: input.projectId, actorUserId: actor.userId,
        entityType: 'task', entityId: r.id, action: 'task.created',
        data: { title, owner: ownerUserId, priority, due: input.due ?? null, area: areaId },
      });
      return r.id;
    });
    return this.get(actor, id);
  }

  /**
   * Applies a patch and logs every changed field. Idempotent: a patch that
   * changes nothing writes nothing and returns `changed: false`.
   */
  async update(actor: Actor, id: number, patch: TaskPatch): Promise<{ task: TaskView; changed: boolean }> {
    const before = await this.get(actor, id);
    await this.permissions.authorize(actor, 'task.update', { projectId: before.project_id });

    const set: Partial<TaskRow> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const note = (field: string, from: unknown, to: unknown) => {
      if (from !== to) changes[field] = { from, to };
    };

    const projectId = patch.projectId ?? before.project_id;
    if (patch.projectId !== undefined && patch.projectId !== before.project_id) {
      await this.permissions.authorize(actor, 'task.create', { projectId: patch.projectId });
      set.project_id = patch.projectId;
      note('project', before.project_id, patch.projectId);
      // area must belong to the project; owner must have access to it
      if (patch.areaId === undefined && before.area_id !== null) {
        set.area_id = null;
        note('area', before.area_id, null);
      }
      if (patch.ownerUserId === undefined && before.owner_user_id !== null) {
        await this.assertOwner(actor, before.owner_user_id, patch.projectId);
      }
    }
    if (patch.title !== undefined) {
      const t = this.cleanTitle(patch.title);
      if (t !== before.title) {
        set.title = t;
        note('title', before.title, t);
      }
    }
    if (patch.notes !== undefined) {
      const n = patch.notes?.trim() || null;
      if (n !== before.notes) {
        set.notes = n;
        note('notes', before.notes ? '…' : null, n ? '…' : null);
      }
    }
    if (patch.priority !== undefined && patch.priority !== before.priority) {
      if (!PRIORITIES.includes(patch.priority)) throw new DomainError('task.bad_priority');
      set.priority = patch.priority;
      note('priority', before.priority, patch.priority);
    }
    if (patch.status !== undefined && patch.status !== before.status) {
      if (!TASK_STATUSES.includes(patch.status)) throw new DomainError('task.bad_status');
      set.status = patch.status;
      set.completed_at = patch.status === 'done' ? toDb(this.clock.now()) : null;
      note('status', before.status, patch.status);
    }
    if (patch.ownerUserId !== undefined && patch.ownerUserId !== before.owner_user_id) {
      await this.assertOwner(actor, patch.ownerUserId, projectId);
      set.owner_user_id = patch.ownerUserId;
      note('owner', before.owner_user_id, patch.ownerUserId);
    }
    if (patch.areaId !== undefined && patch.areaId !== before.area_id) {
      set.area_id = await this.checkArea(patch.areaId, projectId);
      note('area', before.area_id, set.area_id);
    }
    if (patch.due !== undefined) {
      const cols = this.dueColumns(patch.due);
      if (cols.due_date !== before.due_date || cols.due_at !== before.due_at) {
        Object.assign(set, cols);
        note('due', describeDue(before), patch.due ? `${patch.due.date}${patch.due.time ? ` ${patch.due.time}` : ''}` : null);
      }
    }

    if (Object.keys(changes).length === 0) return { task: before, changed: false };

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('tasks')
        .set({ ...set, updated_at: toDb(this.clock.now()) })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId,
        entityType: 'task', entityId: id, action: 'task.updated', data: { changes },
      });
    });
    return { task: await this.get(actor, id), changed: true };
  }

  async setStatus(actor: Actor, id: number, status: TaskStatus) {
    return this.update(actor, id, { status });
  }

  async snooze(actor: Actor, id: number, opt: SnoozeOption) {
    const task = await this.get(actor, id);
    const now = this.clock.now();
    let due: Due;
    const keepTime = task.due_at ? fromLocalTime(task) : null;
    switch (opt) {
      case '1h':
      case '3h': {
        const t = roundUp5(now.plus({ hours: opt === '1h' ? 1 : 3 }));
        due = { date: t.toFormat('yyyy-MM-dd'), time: t.toFormat('HH:mm') };
        break;
      }
      case 'tom':
        due = { date: localDate(now.plus({ days: 1 })), time: keepTime ?? (task.due_date ? null : '09:00') };
        break;
      case 'nw': {
        const monday = now.plus({ weeks: 1 }).startOf('week');
        due = { date: localDate(monday), time: keepTime ?? (task.due_date ? null : '09:00') };
        break;
      }
    }
    return this.update(actor, id, { due });
  }

  /** Soft delete. Safe to repeat. */
  async remove(actor: Actor, id: number): Promise<{ task: TaskView; changed: boolean }> {
    const task = await this.get(actor, id, { includeDeleted: true });
    await this.permissions.authorize(actor, 'task.delete', { projectId: task.project_id });
    if (task.deleted_at) return { task, changed: false };
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('tasks').set({ deleted_at: now, deleted_by: actor.userId, updated_at: now }).where('id', '=', id).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: task.project_id, actorUserId: actor.userId,
        entityType: 'task', entityId: id, action: 'task.deleted', data: { title: task.title },
      });
    });
    return { task: await this.get(actor, id, { includeDeleted: true }), changed: true };
  }

  /** Undo a soft delete. Safe to repeat. */
  async restore(actor: Actor, id: number): Promise<{ task: TaskView; changed: boolean }> {
    const task = await this.get(actor, id, { includeDeleted: true });
    await this.permissions.authorize(actor, 'task.delete', { projectId: task.project_id });
    if (!task.deleted_at) return { task, changed: false };
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('tasks').set({ deleted_at: null, deleted_by: null, updated_at: now }).where('id', '=', id).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: task.project_id, actorUserId: actor.userId,
        entityType: 'task', entityId: id, action: 'task.restored',
      });
    });
    return { task: await this.get(actor, id), changed: true };
  }

  /** /undo — restores the actor's most recent deletion from the last 24 hours. */
  async undoLastDelete(actor: Actor): Promise<TaskView | null> {
    const since = toDb(this.clock.now().minus({ hours: 24 }));
    const recent = await this.events.lastByActor(this.db, actor.workspaceId, actor.userId, ['task.deleted'], since);
    for (const e of recent) {
      if (e.entity_id == null) continue;
      try {
        const r = await this.restore(actor, e.entity_id);
        if (r.changed) return r.task;
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
      }
    }
    return null;
  }

  // ---------- internals ----------

  private baseQuery() {
    return this.db
      .selectFrom('tasks as t')
      .innerJoin('projects as p', 'p.id', 't.project_id')
      .leftJoin('areas as a', 'a.id', 't.area_id')
      .leftJoin('workspace_members as wm', (j) =>
        j.onRef('wm.user_id', '=', 't.owner_user_id').onRef('wm.workspace_id', '=', 't.workspace_id'),
      )
      .selectAll('t')
      .select(['p.code as project_code', 'p.name as project_name', 'a.name as area_name', 'wm.display_name as owner_name']);
  }

  private cleanTitle(title: string): string {
    const t = title.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!t) throw new DomainError('task.empty_title');
    if (t.length > 200) throw new DomainError('task.title_too_long');
    return t;
  }

  private async assertOwner(actor: Actor, ownerUserId: number | null, projectId: number): Promise<void> {
    if (ownerUserId === null) return;
    const ok = await this.permissions.can({ userId: ownerUserId, workspaceId: actor.workspaceId }, 'task.view', { projectId });
    if (!ok) throw new DomainError('task.owner_no_access');
  }

  private async checkArea(areaId: number | null, projectId: number): Promise<number | null> {
    if (areaId === null) return null;
    const a = await this.db.selectFrom('areas').select(['project_id']).where('id', '=', areaId).executeTakeFirst();
    if (!a || a.project_id !== projectId) throw new DomainError('task.area_mismatch');
    return areaId;
  }

  private dueColumns(due: Due | null): { due_date: string | null; due_at: string | null } {
    if (!due) return { due_date: null, due_at: null };
    if (!fromLocalDate(due.date).isValid) throw new DomainError('task.bad_due');
    if (!due.time) return { due_date: due.date, due_at: null };
    const [h, m] = due.time.split(':').map(Number);
    const at = atLocal(due.date, h!, m!);
    if (!at.isValid) throw new DomainError('task.bad_due');
    return { due_date: due.date, due_at: toDb(at) };
  }
}

function describeDue(t: TaskRow): string | null {
  if (!t.due_date) return null;
  return t.due_at ? `${t.due_date} ${fromLocalTime(t)}` : t.due_date;
}

function fromLocalTime(t: TaskRow): string | null {
  // due_at is UTC; show the workspace wall-clock time
  return t.due_at ? fromDb(t.due_at).toFormat('HH:mm') : null;
}

function roundUp5(dt: DateTime): DateTime {
  const extra = (5 - (dt.minute % 5)) % 5;
  return dt.plus({ minutes: extra }).set({ second: 0, millisecond: 0 });
}
