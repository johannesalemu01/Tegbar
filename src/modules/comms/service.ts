import type { Generated, Kysely, Selectable } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { Db } from '../../core/db/database.js';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../core/errors.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog } from '../../core/services/events.js';
import type { Jobs } from '../../core/services/jobs.js';
import type { Members } from '../../core/services/members.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Purger } from '../../core/services/purge.js';
import type { SearchHit } from '../../core/services/search.js';
import { toDb, type Clock } from '../../core/time.js';

export type NoticeLevel = 'info' | 'important' | 'urgent';
export const LEVELS: readonly NoticeLevel[] = ['info', 'important', 'urgent'];
export const URGENT_EVERY_MIN = 30;
export const URGENT_MAX = 6;

export interface NoticesTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  level: NoticeLevel;
  body: string;
  created_by: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface NoticeAcksTable {
  id: Generated<number>;
  workspace_id: number;
  notice_id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
}
/** /tell messages between members (kept for context and Reply). */
export interface MessagesTable {
  id: Generated<number>;
  workspace_id: number;
  from_user_id: number;
  to_user_id: number;
  body: string;
  reply_to: number | null;
  created_at: string;
  updated_at: string;
}
export type NoticeRow = Selectable<NoticesTable>;
export type MessageRow = Selectable<MessagesTable>;
declare module '../../core/db/schema.js' {
  interface DB {
    notices: NoticesTable;
    notice_acks: NoticeAcksTable;
    messages: MessagesTable;
  }
}

export const commsMigrations: Record<string, Migration> = {
  '202611150800_comms_init': {
    async up(db: Kysely<any>) {
      await withStamps(withWorkspace(withId(db.schema.createTable('notices')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('level', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('archived_at', 'text')
        .addColumn('deleted_at', 'text')).execute();
      await withStamps(withWorkspace(withId(db.schema.createTable('notice_acks')))
        .addColumn('notice_id', 'integer', (c) => c.notNull().references('notices.id').onDelete('cascade'))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id'))
        .addUniqueConstraint('notice_ack_once', ['notice_id', 'user_id'])).execute();
      await withStamps(withWorkspace(withId(db.schema.createTable('messages')))
        .addColumn('from_user_id', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('to_user_id', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('reply_to', 'integer')).execute();
    },
    async down(db: Kysely<any>) {
      for (const t of ['messages', 'notice_acks', 'notices']) await db.schema.dropTable(t).ifExists().execute();
    },
  },
};

export const COMMS_JOB = { send: 'notice.send', renotify: 'notice.renotify', acked: 'notice.acked', tell: 'tell.send' } as const;

export interface NoticeView extends NoticeRow {
  project_code: string;
  acked_by: number[];
  recipients: number[];
}

export class CommsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly members: Members,
    private readonly jobs: Jobs,
  ) {}

  // ---------- notices ----------

  async recipients(workspaceId: number, projectId: number, poster: number): Promise<number[]> {
    const out: number[] = [];
    for (const m of await this.members.list(workspaceId)) {
      if (m.user_id !== poster && (await this.permissions.can({ userId: m.user_id, workspaceId }, 'project.view', { projectId }))) out.push(m.user_id);
    }
    return out;
  }

  async post(actor: Actor, i: { projectId: number; level: NoticeLevel; body: string }): Promise<NoticeView> {
    await this.permissions.authorize(actor, 'notice.post', { projectId: i.projectId });
    if (!LEVELS.includes(i.level)) throw new DomainError('notice.bad_level');
    const body = i.body.normalize('NFC').trim();
    if (!body || body.length > 2000) throw new DomainError('notice.bad_body');
    const now = this.clock.now();
    const row = await this.db.insertInto('notices').values({
      workspace_id: actor.workspaceId, project_id: i.projectId, level: i.level, body, created_by: actor.userId,
      archived_at: null, deleted_at: null, created_at: toDb(now), updated_at: toDb(now),
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: i.projectId, actorUserId: actor.userId, entityType: 'notice', entityId: row.id, action: 'notice.posted', data: { level: i.level } });
    await this.jobs.upsert(actor.workspaceId, `notice:${row.id}:send`, { kind: COMMS_JOB.send, payload: { noticeId: row.id }, at: now });
    if (i.level === 'urgent') {
      await this.jobs.upsert(actor.workspaceId, `notice:${row.id}:renotify`, { kind: COMMS_JOB.renotify, payload: { noticeId: row.id, count: 0 }, at: now.plus({ minutes: URGENT_EVERY_MIN }) });
    }
    return this.view(actor.workspaceId, row);
  }

  private async view(workspaceId: number, n: NoticeRow): Promise<NoticeView> {
    const [acks, project] = await Promise.all([
      this.db.selectFrom('notice_acks').select('user_id').where('notice_id', '=', n.id).orderBy('id').execute(),
      this.db.selectFrom('projects').select('code').where('id', '=', n.project_id).executeTakeFirst(),
    ]);
    return { ...n, project_code: project?.code ?? '?', acked_by: acks.map((a) => a.user_id), recipients: await this.recipients(workspaceId, n.project_id, n.created_by) };
  }

  async byId(workspaceId: number, id: number): Promise<NoticeView | null> {
    const n = await this.db.selectFrom('notices').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
    return n ? this.view(workspaceId, n) : null;
  }

  async get(actor: Actor, id: number): Promise<NoticeView> {
    const n = await this.db.selectFrom('notices').selectAll().where('workspace_id', '=', actor.workspaceId).where('id', '=', id).executeTakeFirst();
    if (!n || n.deleted_at) throw new NotFoundError();
    await this.permissions.authorize(actor, 'project.view', { projectId: n.project_id });
    return this.view(actor.workspaceId, n);
  }

  async list(actor: Actor, archived: boolean, limit = 10): Promise<NoticeView[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    const rows = await this.db.selectFrom('notices').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', visible).where('deleted_at', 'is', null)
      .where('archived_at', archived ? 'is not' : 'is', null)
      .orderBy('id', 'desc').limit(limit).execute();
    return Promise.all(rows.map((r) => this.view(actor.workspaceId, r)));
  }

  /** Idempotent acknowledgement; the poster is told once. */
  async ack(actor: Actor, id: number): Promise<{ notice: NoticeView; changed: boolean }> {
    const n = await this.get(actor, id);
    if (n.created_by === actor.userId) throw new DomainError('notice.own');
    const now = toDb(this.clock.now());
    const r = await this.db.insertInto('notice_acks').values({ workspace_id: actor.workspaceId, notice_id: id, user_id: actor.userId, created_at: now, updated_at: now })
      .onConflict((oc) => oc.columns(['notice_id', 'user_id']).doNothing()).returning('id').executeTakeFirst();
    if (!r) return { notice: n, changed: false };
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: n.project_id, actorUserId: actor.userId, entityType: 'notice', entityId: id, action: 'notice.acknowledged' });
    await this.jobs.upsert(actor.workspaceId, `notice:${id}:ack:${actor.userId}`, { kind: COMMS_JOB.acked, payload: { noticeId: id, userId: actor.userId }, at: this.clock.now() });
    return { notice: await this.get(actor, id), changed: true };
  }

  async archive(actor: Actor, id: number, archived: boolean): Promise<{ changed: boolean }> {
    const n = await this.get(actor, id);
    if (n.created_by !== actor.userId && !(await this.permissions.can(actor, 'project.update', { projectId: n.project_id }))) throw new ForbiddenError();
    if (Boolean(n.archived_at) === archived) return { changed: false };
    await this.db.updateTable('notices').set({ archived_at: archived ? toDb(this.clock.now()) : null, updated_at: toDb(this.clock.now()) }).where('id', '=', id).execute();
    if (archived) await this.jobs.cancel(actor.workspaceId, `notice:${id}:renotify`);
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: n.project_id, actorUserId: actor.userId, entityType: 'notice', entityId: id, action: archived ? 'notice.archived' : 'notice.unarchived' });
    return { changed: true };
  }

  async search(actor: Actor, pattern: string, limit: number): Promise<SearchHit[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    const rows = await this.db.selectFrom('notices as n').innerJoin('projects as p', 'p.id', 'n.project_id')
      .select(['n.id', 'n.body', 'n.level', 'n.created_at', 'p.code'])
      .where('n.workspace_id', '=', actor.workspaceId).where('n.project_id', 'in', visible).where('n.deleted_at', 'is', null)
      .where((eb) => eb(eb.fn('lower', ['n.body']), 'like', pattern))
      .orderBy('n.id', 'desc').limit(limit).execute();
    return rows.map((r) => ({ type: 'notice', id: r.id, title: r.body.split('\n')[0]!.slice(0, 80), snippet: r.level, date: r.created_at, projectCode: r.code }));
  }

  purger(): Purger {
    return {
      type: 'notices', label: 'archived notices', twoKey: false,
      candidates: async (actor) => {
        const visible = await this.permissions.visibleProjectIds(actor);
        if (!visible.length) return [];
        return (await this.db.selectFrom('notices').select(['id', 'body']).where('workspace_id', '=', actor.workspaceId)
          .where('project_id', 'in', visible).where('archived_at', 'is not', null).execute()).map((n) => ({ id: n.id, label: n.body.slice(0, 40) }));
      },
      purge: async (actor, ids) => this.db.transaction().execute(async (trx) => {
        const r = await trx.deleteFrom('notices').where('workspace_id', '=', actor.workspaceId).where('id', 'in', ids).where('archived_at', 'is not', null).executeTakeFirst();
        await this.events.redact(trx, actor.workspaceId, 'notice', ids);
        await this.events.record(trx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'purge', action: 'purge.notices', data: { count: Number(r.numDeletedRows) } });
        return { rows: Number(r.numDeletedRows), files: 0 };
      }),
    };
  }

  // ---------- /tell ----------

  async tell(actor: Actor, toUserId: number, body: string, replyTo: number | null = null): Promise<MessageRow> {
    await this.permissions.authorize(actor, 'workspace.view');
    if (toUserId === actor.userId) throw new DomainError('tell.self');
    if (!(await this.members.get(actor.workspaceId, toUserId))) throw new DomainError('cost.bad_payer');
    const text = body.normalize('NFC').trim();
    if (!text || text.length > 3000) throw new DomainError('notice.bad_body');
    const now = this.clock.now();
    const row = await this.db.insertInto('messages').values({
      workspace_id: actor.workspaceId, from_user_id: actor.userId, to_user_id: toUserId, body: text, reply_to: replyTo, created_at: toDb(now), updated_at: toDb(now),
    }).returningAll().executeTakeFirstOrThrow();
    await this.jobs.upsert(actor.workspaceId, `tell:${row.id}`, { kind: COMMS_JOB.tell, payload: { messageId: row.id }, at: now });
    return row;
  }

  async message(workspaceId: number, id: number): Promise<MessageRow | undefined> {
    return this.db.selectFrom('messages').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }
}
