import type { DateTime } from 'luxon';
import type { Db } from '../../core/db/database.js';
import { DomainError, NotFoundError } from '../../core/errors.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog } from '../../core/services/events.js';
import type { Jobs } from '../../core/services/jobs.js';
import type { Members } from '../../core/services/members.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Settings } from '../../core/services/settings.js';
import { atLocal, fromDb, fromLocalDate, getZone, toDb, type Clock } from '../../core/time.js';
import type { TaskService, TaskView } from '../tasks/service.js';
import type { ReminderRow } from './schema.js';
import {
  DIGEST_SETTING_KEYS, S_DATEONLY_TIME, S_DIGEST_DAILY, S_DIGEST_PLAN, S_DIGEST_REVIEW, S_REMIND_BEFORE,
  TASK_REMINDER_SETTING_KEYS, type WeeklySlot,
} from './settings.js';

export const JOB = {
  taskRemind: 'task.remind',
  taskOverdue: 'task.overdue',
  digestDaily: 'digest.daily',
  digestPlan: 'digest.plan',
  digestReview: 'digest.review',
  reminder: 'reminder.fire',
} as const;

export type DigestKind = 'daily' | 'plan' | 'review';

export interface TaskJobPayload {
  taskId: number;
  /** due_date|due_at at planning time — a mismatch at fire time means the job is obsolete. */
  dueKey: string;
  offset: number; // minutes before due; 0 = at due time
}
export interface OverduePayload {
  taskId: number;
  dueKey: string;
  count: number;
}
export interface DigestPayload {
  userId: number;
  kind: DigestKind;
}
export interface ReminderPayload {
  reminderId: number;
}

export const dueKeyOf = (t: Pick<TaskView, 'due_date' | 'due_at'>) => `${t.due_date ?? ''}|${t.due_at ?? ''}`;

// ---------- schedule maths ----------

export function nextDaily(time: string, now: DateTime): DateTime {
  const [h, m] = time.split(':').map(Number);
  let t = now.setZone(getZone()).set({ hour: h!, minute: m!, second: 0, millisecond: 0 });
  if (t <= now) t = t.plus({ days: 1 });
  return t;
}

export function nextWeekly(slot: WeeklySlot, now: DateTime): DateTime {
  const [h, m] = slot.time.split(':').map(Number);
  const local = now.setZone(getZone());
  let t = local.set({ hour: h!, minute: m!, second: 0, millisecond: 0 }).plus({ days: (slot.day - local.weekday + 7) % 7 });
  if (t <= now) t = t.plus({ weeks: 1 });
  return t;
}

/**
 * Decides which scheduled jobs should exist. Every method is idempotent:
 * call it after any change and the jobs table converges to the right state.
 */
export class ReminderPlanner {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: Jobs,
    private readonly settings: Settings,
    private readonly tasks: TaskService,
    private readonly members: Members,
  ) {}

  /** Owner's view of a task, or null if it has no owner / the owner lost access / it is gone. */
  async taskForOwner(workspaceId: number, taskId: number): Promise<{ task: TaskView; owner: Actor } | null> {
    const info = await this.tasks.ownerOf(workspaceId, taskId);
    if (!info?.ownerUserId) return null;
    const owner = { userId: info.ownerUserId, workspaceId };
    try {
      return { task: await this.tasks.get(owner, taskId), owner }; // permission-checked
    } catch (err) {
      if (err instanceof DomainError) return null;
      throw err;
    }
  }

  async syncTask(workspaceId: number, taskId: number): Promise<void> {
    const prefix = `task:${taskId}:`;
    const found = await this.taskForOwner(workspaceId, taskId);
    if (!found || found.task.status === 'done' || !found.task.due_date) {
      await this.jobs.cancelPrefix(workspaceId, prefix);
      return;
    }
    const { task, owner } = found;
    const now = this.clock.now();
    const dueKey = dueKeyOf(task);
    const keep: string[] = [];
    const put = async (key: string, kind: string, at: DateTime, payload: unknown) => {
      keep.push(key);
      await this.jobs.upsert(workspaceId, key, { kind, userId: owner.userId, payload, at });
    };

    let overdueAt: DateTime;
    if (task.due_at) {
      const dueAt = fromDb(task.due_at);
      for (const m of await this.settings.get(workspaceId, S_REMIND_BEFORE, owner.userId)) {
        const at = dueAt.minus({ minutes: m });
        if (at > now) await put(`${prefix}b${m}`, JOB.taskRemind, at, { taskId, dueKey, offset: m } satisfies TaskJobPayload);
      }
      if (dueAt > now) await put(`${prefix}due`, JOB.taskRemind, dueAt, { taskId, dueKey, offset: 0 } satisfies TaskJobPayload);
      overdueAt = dueAt.plus({ hours: 1 });
    } else {
      const [h, m] = (await this.settings.get(workspaceId, S_DATEONLY_TIME, owner.userId)).split(':').map(Number);
      const dueDate = task.due_date!;
      const at = atLocal(dueDate, h!, m!);
      if (at > now) await put(`${prefix}due`, JOB.taskRemind, at, { taskId, dueKey, offset: 0 } satisfies TaskJobPayload);
      overdueAt = atLocal(fromLocalDate(dueDate).plus({ days: 1 }).toFormat('yyyy-MM-dd'), h!, m!);
    }

    // Overdue nudges: keep the existing series (and its counter) unless the due date changed.
    const odKey = `${prefix}od`;
    const existing = await this.jobs.get(workspaceId, odKey);
    const same = existing && (JSON.parse(existing.payload) as OverduePayload).dueKey === dueKey && existing.status !== 'cancelled';
    keep.push(odKey);
    if (!same) {
      const at = overdueAt > now ? overdueAt : now.plus({ hours: 1 });
      await this.jobs.upsert(workspaceId, odKey, {
        kind: JOB.taskOverdue, userId: owner.userId, payload: { taskId, dueKey, count: 0 } satisfies OverduePayload, at,
      });
    }
    await this.jobs.cancelPrefix(workspaceId, prefix, keep);
  }

  async syncDigests(workspaceId: number, userId: number): Promise<void> {
    const now = this.clock.now();
    for (const kind of ['daily', 'plan', 'review'] as const) {
      const key = `digest:${kind}:${userId}`;
      const at = await this.nextDigest(workspaceId, userId, kind, now);
      if (!at) await this.jobs.cancel(workspaceId, key);
      else {
        const job = await this.jobs.get(workspaceId, key);
        // Don't move a job that is already correctly scheduled (keeps a held digest held).
        if (job?.status === 'active' && job.next_fire_at === toDb(at)) continue;
        const kindName = kind === 'daily' ? JOB.digestDaily : kind === 'plan' ? JOB.digestPlan : JOB.digestReview;
        await this.jobs.upsert(workspaceId, key, { kind: kindName, userId, payload: { userId, kind } satisfies DigestPayload, at });
      }
    }
  }

  async nextDigest(workspaceId: number, userId: number, kind: DigestKind, after: DateTime): Promise<DateTime | null> {
    if (kind === 'daily') {
      const t = await this.settings.get(workspaceId, S_DIGEST_DAILY, userId);
      return t ? nextDaily(t, after) : null;
    }
    const slot = await this.settings.get(workspaceId, kind === 'plan' ? S_DIGEST_PLAN : S_DIGEST_REVIEW, userId);
    return slot ? nextWeekly(slot, after) : null;
  }

  async syncUser(workspaceId: number, userId: number): Promise<void> {
    await this.syncDigests(workspaceId, userId);
    for (const id of await this.tasks.openDatedIds(workspaceId)) {
      const info = await this.tasks.ownerOf(workspaceId, id);
      if (info?.ownerUserId === userId) await this.syncTask(workspaceId, id);
    }
  }

  async onUserSetting(workspaceId: number, userId: number, key: string): Promise<void> {
    if (DIGEST_SETTING_KEYS.has(key)) await this.syncDigests(workspaceId, userId);
    if (TASK_REMINDER_SETTING_KEYS.has(key)) await this.syncUser(workspaceId, userId);
  }

  /** At start-up: make sure every job that should exist does. */
  async syncAll(workspaceId: number): Promise<void> {
    for (const m of await this.members.list(workspaceId)) await this.syncDigests(workspaceId, m.user_id);
    for (const id of await this.tasks.openDatedIds(workspaceId)) await this.syncTask(workspaceId, id);
  }
}

/** One-off reminders ("remind me / remind us"). */
export class ReminderService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly jobs: Jobs,
    private readonly members: Members,
  ) {}

  async create(actor: Actor, input: { text: string; at: DateTime; recipients: number[]; sourceId?: number }): Promise<ReminderRow> {
    await this.permissions.authorize(actor, 'reminder.create');
    const text = input.text.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!text) throw new DomainError('rem.empty');
    if (text.length > 500) throw new DomainError('rem.too_long');
    if (input.at <= this.clock.now()) throw new DomainError('rem.past');
    const active = new Set((await this.members.list(actor.workspaceId)).map((m) => m.user_id));
    const recipients = [...new Set(input.recipients)];
    if (recipients.length === 0 || recipients.some((r) => !active.has(r))) throw new DomainError('rem.bad_recipient');

    const now = toDb(this.clock.now());
    const row = await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('reminders')
        .values({
          workspace_id: actor.workspaceId, project_id: null, created_by: actor.userId, text, remind_at: toDb(input.at),
          recipients: JSON.stringify(recipients), status: 'scheduled', source_id: input.sourceId ?? null,
          created_at: now, updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'reminder', entityId: r.id,
        action: 'reminder.created', data: { at: r.remind_at, recipients },
      });
      return r;
    });
    await this.jobs.upsert(actor.workspaceId, `rem:${row.id}`, {
      kind: JOB.reminder, userId: actor.userId, payload: { reminderId: row.id } satisfies ReminderPayload, at: input.at,
    });
    return row;
  }

  /**
   * Snooze = a personal follow-up of reminder `sourceId`. Idempotent: tapping
   * snooze again moves the same follow-up instead of creating another one.
   */
  async snooze(actor: Actor, sourceId: number, at: DateTime): Promise<ReminderRow> {
    const source = await this.get(actor.workspaceId, sourceId);
    if (!source || !(source.created_by === actor.userId || recipientsOf(source).includes(actor.userId))) throw new NotFoundError();
    const existing = await this.db
      .selectFrom('reminders').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('source_id', '=', sourceId)
      .where('created_by', '=', actor.userId).where('status', '=', 'scheduled')
      .executeTakeFirst();
    if (!existing) return this.create(actor, { text: source.text, at, recipients: [actor.userId], sourceId });
    await this.permissions.authorize(actor, 'reminder.create');
    if (at <= this.clock.now()) throw new DomainError('rem.past');
    await this.db.updateTable('reminders').set({ remind_at: toDb(at), updated_at: toDb(this.clock.now()) }).where('id', '=', existing.id).execute();
    await this.jobs.upsert(actor.workspaceId, `rem:${existing.id}`, {
      kind: JOB.reminder, userId: actor.userId, payload: { reminderId: existing.id } satisfies ReminderPayload, at,
    });
    return { ...existing, remind_at: toDb(at) };
  }

  async get(workspaceId: number, id: number): Promise<ReminderRow | undefined> {
    return this.db.selectFrom('reminders').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }

  /** Upcoming reminders the actor created or receives. */
  async upcoming(actor: Actor): Promise<ReminderRow[]> {
    await this.permissions.authorize(actor, 'reminder.view');
    const rows = await this.db
      .selectFrom('reminders').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('status', '=', 'scheduled')
      .orderBy('remind_at').limit(50)
      .execute();
    return rows.filter((r) => r.created_by === actor.userId || recipientsOf(r).includes(actor.userId)).slice(0, 15);
  }

  async cancel(actor: Actor, id: number): Promise<{ changed: boolean }> {
    await this.permissions.authorize(actor, 'reminder.create');
    const r = await this.get(actor.workspaceId, id);
    if (!r || !(r.created_by === actor.userId || recipientsOf(r).includes(actor.userId))) throw new NotFoundError();
    if (r.status !== 'scheduled') return { changed: false };
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('reminders').set({ status: 'cancelled', updated_at: now }).where('id', '=', id).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'reminder', entityId: id, action: 'reminder.cancelled',
      });
    });
    await this.jobs.cancel(actor.workspaceId, `rem:${id}`);
    return { changed: true };
  }

  async markSent(workspaceId: number, id: number): Promise<void> {
    await this.db
      .updateTable('reminders').set({ status: 'sent', updated_at: toDb(this.clock.now()) })
      .where('workspace_id', '=', workspaceId).where('id', '=', id).where('status', '=', 'scheduled')
      .execute();
  }
}

export function recipientsOf(r: ReminderRow): number[] {
  try {
    const v: unknown = JSON.parse(r.recipients);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}
