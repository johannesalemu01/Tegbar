import type { Generated, Kysely, Selectable } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { Db } from '../../core/db/database.js';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';
import { DomainError, NotFoundError } from '../../core/errors.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog } from '../../core/services/events.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Projects } from '../../core/services/projects.js';
import type { Purger } from '../../core/services/purge.js';
import type { SearchHit } from '../../core/services/search.js';
import { toDb, type Clock } from '../../core/time.js';

// ---------- schema ----------

/** Notes and links (a note with a url) per project, with tags. Soft-deleted, purgeable. */
export interface NotesTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  title: string;
  body: string | null;
  url: string | null;
  tags: string; // JSON string[]
  created_by: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export type NoteRow = Selectable<NotesTable>;
declare module '../../core/db/schema.js' {
  interface DB {
    notes: NotesTable;
  }
}

export const noteMigrations: Record<string, Migration> = {
  '202611150600_notes_init': {
    async up(db: Kysely<any>) {
      await withStamps(withWorkspace(withId(db.schema.createTable('notes')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('body', 'text')
        .addColumn('url', 'text')
        .addColumn('tags', 'text', (c) => c.notNull())
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('deleted_at', 'text')).execute();
      await db.schema.createIndex('notes_project').on('notes').columns(['workspace_id', 'project_id', 'deleted_at']).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('notes').ifExists().execute();
    },
  },
};

// ---------- parsing (pure) ----------

const URL_RE = /https?:\/\/[^\s<>"]+/i;

/** "Pricing call notes #ridehome #sales https://… body" → parts. Unknown #tags become note tags. */
export function parseNote(text: string, projectCodes: string[]): { title: string; body: string | null; url: string | null; tags: string[]; projectCode: string | null } {
  let rest = text.normalize('NFC').trim();
  const url = URL_RE.exec(rest)?.[0] ?? null;
  if (url) rest = rest.replace(url, ' ');
  const tags: string[] = [];
  let projectCode: string | null = null;
  rest = rest.replace(/(^|\s)#([\p{L}\p{N}_-]{1,30})(?=\s|$)/gu, (_m, lead: string, tag: string) => {
    const t = tag.toLowerCase();
    const code = projectCodes.find((c) => c.toLowerCase() === t);
    if (code && !projectCode) projectCode = code;
    else if (!tags.includes(t)) tags.push(t);
    return lead;
  });
  const lines = rest.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const first = lines.find(Boolean) ?? '';
  const title = (first || (url ? url.replace(/^https?:\/\//, '').slice(0, 60) : '')).slice(0, 120);
  const body = lines.slice(lines.indexOf(first) + 1).join('\n').trim() || null;
  return { title, body, url, tags, projectCode };
}

// ---------- service ----------

export class NoteService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly projects: Projects,
  ) {}

  async create(actor: Actor, i: { projectId: number; title: string; body?: string | null; url?: string | null; tags?: string[] }): Promise<NoteRow> {
    await this.permissions.authorize(actor, 'note.create', { projectId: i.projectId });
    const title = i.title.trim();
    if (!title || title.length > 120) throw new DomainError('note.bad_title');
    if ((i.body ?? '').length > 4000) throw new DomainError('note.too_long');
    if (i.url && !/^https?:\/\/\S+$/i.test(i.url)) throw new DomainError('project.bad_url');
    const now = toDb(this.clock.now());
    const row = await this.db.insertInto('notes').values({
      workspace_id: actor.workspaceId, project_id: i.projectId, title, body: i.body?.trim() || null, url: i.url ?? null,
      tags: JSON.stringify((i.tags ?? []).slice(0, 10)), created_by: actor.userId, deleted_at: null, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: i.projectId, actorUserId: actor.userId, entityType: 'note', entityId: row.id, action: 'note.created', data: { title } });
    return row;
  }

  async get(actor: Actor, id: number, includeDeleted = false): Promise<NoteRow & { project_code: string }> {
    const r = await this.db.selectFrom('notes as n').innerJoin('projects as p', 'p.id', 'n.project_id').selectAll('n').select('p.code as project_code')
      .where('n.id', '=', id).where('n.workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!r || (r.deleted_at && !includeDeleted)) throw new NotFoundError();
    await this.permissions.authorize(actor, 'project.view', { projectId: r.project_id });
    return r;
  }

  async list(actor: Actor, f: { projectId?: number | null; tag?: string | null }, page = 0, pageSize = 8) {
    const visible = await this.permissions.visibleProjectIds(actor);
    const ids = f.projectId ? visible.filter((v) => v === f.projectId) : visible;
    if (!ids.length) return { items: [], total: 0 };
    let q = this.db.selectFrom('notes as n').innerJoin('projects as p', 'p.id', 'n.project_id')
      .where('n.workspace_id', '=', actor.workspaceId).where('n.project_id', 'in', ids).where('n.deleted_at', 'is', null);
    if (f.tag) q = q.where('n.tags', 'like', `%"${f.tag.replace(/[%_"\\]/g, '')}"%`);
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('c')).executeTakeFirst())?.c ?? 0);
    const items = await q.selectAll('n').select('p.code as project_code').orderBy('n.id', 'desc').limit(pageSize).offset(page * pageSize).execute();
    return { items, total };
  }

  async update(actor: Actor, id: number, patch: { title?: string; body?: string | null }): Promise<NoteRow> {
    const n = await this.get(actor, id);
    await this.permissions.authorize(actor, 'note.create', { projectId: n.project_id });
    if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 120)) throw new DomainError('note.bad_title');
    await this.db.updateTable('notes').set({ ...patch, updated_at: toDb(this.clock.now()) }).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: n.project_id, actorUserId: actor.userId, entityType: 'note', entityId: id, action: 'note.updated', data: { fields: Object.keys(patch) } });
    return this.get(actor, id);
  }

  /** Soft delete / restore. Idempotent. */
  async setDeleted(actor: Actor, id: number, deleted: boolean): Promise<{ changed: boolean }> {
    const n = await this.get(actor, id, true);
    await this.permissions.authorize(actor, 'note.create', { projectId: n.project_id });
    if (Boolean(n.deleted_at) === deleted) return { changed: false };
    await this.db.updateTable('notes').set({ deleted_at: deleted ? toDb(this.clock.now()) : null, updated_at: toDb(this.clock.now()) }).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: n.project_id, actorUserId: actor.userId, entityType: 'note', entityId: id, action: deleted ? 'note.deleted' : 'note.restored' });
    return { changed: true };
  }

  async search(actor: Actor, pattern: string, limit: number): Promise<SearchHit[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    const rows = await this.db.selectFrom('notes as n').innerJoin('projects as p', 'p.id', 'n.project_id')
      .select(['n.id', 'n.title', 'n.body', 'n.url', 'n.created_at', 'p.code'])
      .where('n.workspace_id', '=', actor.workspaceId).where('n.project_id', 'in', visible).where('n.deleted_at', 'is', null)
      .where((eb) => eb.or([
        eb(eb.fn('lower', ['n.title']), 'like', pattern), eb(eb.fn('lower', ['n.body']), 'like', pattern), eb(eb.fn('lower', ['n.tags']), 'like', pattern),
      ]))
      .orderBy('n.id', 'desc').limit(limit).execute();
    return rows.map((r) => ({ type: 'note', id: r.id, title: r.title, snippet: r.body?.slice(0, 80) ?? r.url, date: r.created_at, projectCode: r.code }));
  }

  purger(): Purger {
    return {
      type: 'notes', label: 'deleted notes', twoKey: false,
      candidates: async (actor) => {
        const visible = await this.permissions.visibleProjectIds(actor);
        if (!visible.length) return [];
        return (await this.db.selectFrom('notes').select(['id', 'title']).where('workspace_id', '=', actor.workspaceId)
          .where('project_id', 'in', visible).where('deleted_at', 'is not', null).execute()).map((n) => ({ id: n.id, label: n.title }));
      },
      purge: async (actor, ids) => this.db.transaction().execute(async (trx) => {
        const r = await trx.deleteFrom('notes').where('workspace_id', '=', actor.workspaceId).where('id', 'in', ids).where('deleted_at', 'is not', null).executeTakeFirst();
        await this.events.redact(trx, actor.workspaceId, 'note', ids);
        await this.events.record(trx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'purge', action: 'purge.notes', data: { count: Number(r.numDeletedRows) } });
        return { rows: Number(r.numDeletedRows), files: 0 };
      }),
    };
  }

  /** Projects visible for parsing #codes. */
  async codes(actor: Actor): Promise<{ id: number; code: string }[]> {
    return (await this.projects.list(actor)).map((p) => ({ id: p.id, code: p.code }));
  }
}
