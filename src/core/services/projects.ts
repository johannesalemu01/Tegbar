import type { Db, DbOrTx } from '../db/database.js';
import type { Area, Project, ProjectStatus } from '../db/schema.js';
import { DomainError, NotFoundError } from '../errors.js';
import { toDb, type Clock } from '../time.js';
import type { Actor } from './context.js';
import type { EventLog } from './events.js';
import type { Permissions } from './permissions.js';
import { S_CURRENT_PROJECT, S_DEFAULT_PROJECT, type Settings } from './settings.js';

export const PROJECT_STATUSES: readonly ProjectStatus[] = ['idea', 'active', 'paused', 'done'];

/** Default areas per seeded project. Tech areas default to seat A, the rest to seat B. */
const TECH_AREAS = new Set(['product', 'engineering', 'design']);
const SEED = [
  {
    code: 'GENERAL', name: 'General', isGeneral: true, status: 'active' as const,
    description: 'Company-wide items that do not belong to a single project.',
    areas: ['Strategy', 'Finance', 'Legal', 'Operations'],
  },
  {
    code: 'RIDEHOME', name: 'RideHome', isGeneral: false, status: 'active' as const,
    description: 'Our first product.',
    areas: ['Product', 'Engineering', 'Design', 'Sales', 'Marketing', 'Operations', 'Finance', 'Legal'],
  },
];
const NEW_PROJECT_AREAS = ['Product', 'Engineering', 'Sales', 'Operations'];

export function slugify(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeCode(code: string): string | null {
  const c = code.trim().replace(/^#/, '').toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,11}$/.test(c) ? c : null;
}

export class Projects {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly settings: Settings,
  ) {}

  // ---------- bootstrap ----------

  /** Idempotent: creates General and RideHome with their areas if missing. */
  async seed(workspaceId: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const s of SEED) {
        const existing = await trx
          .selectFrom('projects').select('id')
          .where('workspace_id', '=', workspaceId).where('code', '=', s.code)
          .executeTakeFirst();
        if (existing) continue;
        const id = await this.insertProject(trx, workspaceId, {
          code: s.code, name: s.name, description: s.description, status: s.status, isGeneral: s.isGeneral, createdBy: null,
        });
        await this.insertAreas(trx, workspaceId, id, s.areas);
        if (s.code === 'RIDEHOME') await this.settings.setSystem(workspaceId, S_DEFAULT_PROJECT, workspaceId, id, trx);
      }
    });
  }

  /** Make every workspace owner an owner of every project (called on pairing and project creation). */
  async syncOwners(exec: DbOrTx, workspaceId: number): Promise<void> {
    const now = toDb(this.clock.now());
    const owners = await exec
      .selectFrom('workspace_members').select('user_id')
      .where('workspace_id', '=', workspaceId).where('role', '=', 'owner').where('status', '=', 'active')
      .execute();
    const projects = await exec.selectFrom('projects').select('id').where('workspace_id', '=', workspaceId).execute();
    for (const p of projects) {
      for (const o of owners) {
        await exec
          .insertInto('project_members')
          .values({ workspace_id: workspaceId, project_id: p.id, user_id: o.user_id, role: 'owner', created_at: now, updated_at: now })
          .onConflict((oc) => oc.columns(['project_id', 'user_id']).doNothing())
          .execute();
      }
    }
  }

  /** Fill empty area owner/backup slots: tech areas → seat A, business areas → seat B. */
  async assignDefaultAreaOwners(exec: DbOrTx, workspaceId: number): Promise<void> {
    const members = await exec
      .selectFrom('workspace_members').select(['user_id', 'seat'])
      .where('workspace_id', '=', workspaceId).where('status', '=', 'active')
      .execute();
    const a = members.find((m) => m.seat === 'A')?.user_id;
    const b = members.find((m) => m.seat === 'B')?.user_id;
    if (!a || !b) return;
    const areas = await exec.selectFrom('areas').select(['id', 'slug', 'owner_user_id']).where('workspace_id', '=', workspaceId).execute();
    const now = toDb(this.clock.now());
    for (const area of areas) {
      if (area.owner_user_id !== null) continue;
      const tech = TECH_AREAS.has(area.slug);
      await exec
        .updateTable('areas')
        .set({ owner_user_id: tech ? a : b, backup_user_id: tech ? b : a, updated_at: now })
        .where('id', '=', area.id)
        .execute();
    }
  }

  // ---------- queries ----------

  async list(actor: Actor, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
    const ids = await this.permissions.visibleProjectIds(actor);
    if (ids.length === 0) return [];
    let q = this.db.selectFrom('projects').selectAll().where('id', 'in', ids);
    if (!opts.includeArchived) q = q.where('archived_at', 'is', null);
    return q.orderBy('is_general', 'asc').orderBy('name').execute();
  }

  async get(actor: Actor, id: number): Promise<Project> {
    await this.permissions.authorize(actor, 'project.view', { projectId: id });
    const p = await this.db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundError();
    return p;
  }

  /** Case-insensitive lookup by code among visible projects. */
  async findByCode(actor: Actor, code: string): Promise<Project | null> {
    const c = normalizeCode(code);
    if (!c) return null;
    const p = await this.db
      .selectFrom('projects').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('code', '=', c)
      .executeTakeFirst();
    if (!p || !(await this.permissions.can(actor, 'project.view', { projectId: p.id }))) return null;
    return p;
  }

  async general(workspaceId: number): Promise<Project> {
    const p = await this.db
      .selectFrom('projects').selectAll()
      .where('workspace_id', '=', workspaceId).where('is_general', '=', 1)
      .executeTakeFirst();
    if (!p) throw new Error('General project missing — seed() not run');
    return p;
  }

  /** The actor's current project: personal choice → workspace default → General. Skips archived/forbidden ones. */
  async current(actor: Actor): Promise<Project> {
    const candidates = [
      await this.settings.get(actor.workspaceId, S_CURRENT_PROJECT, actor.userId),
      await this.settings.get(actor.workspaceId, S_DEFAULT_PROJECT, actor.workspaceId),
    ];
    for (const id of candidates) {
      if (id == null) continue;
      const p = await this.db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
      if (p && !p.archived_at && (await this.permissions.can(actor, 'project.view', { projectId: p.id }))) return p;
    }
    return this.general(actor.workspaceId);
  }

  async setCurrent(actor: Actor, projectId: number): Promise<Project> {
    const p = await this.get(actor, projectId);
    if (p.archived_at) throw new DomainError('project.is_archived');
    await this.settings.setAs(actor, S_CURRENT_PROJECT, actor.userId, p.id);
    return p;
  }

  async areas(actor: Actor, projectId: number): Promise<Area[]> {
    await this.permissions.authorize(actor, 'project.view', { projectId });
    return this.db
      .selectFrom('areas').selectAll()
      .where('project_id', '=', projectId).where('archived_at', 'is', null)
      .orderBy('sort_order').orderBy('name')
      .execute();
  }

  // ---------- commands ----------

  async create(actor: Actor, input: { code: string; name: string; description?: string | null }): Promise<Project> {
    await this.permissions.authorize(actor, 'project.create');
    const code = normalizeCode(input.code);
    if (!code) throw new DomainError('project.bad_code');
    const name = input.name.trim();
    if (!name || name.length > 60) throw new DomainError('project.bad_name');
    const id = await this.db.transaction().execute(async (trx) => {
      const clash = await trx
        .selectFrom('projects').select('id')
        .where('workspace_id', '=', actor.workspaceId).where('code', '=', code)
        .executeTakeFirst();
      if (clash) throw new DomainError('project.code_taken', { code });
      const id = await this.insertProject(trx, actor.workspaceId, {
        code, name, description: input.description?.trim() || null, status: 'active', isGeneral: false, createdBy: actor.userId,
      });
      await this.insertAreas(trx, actor.workspaceId, id, NEW_PROJECT_AREAS);
      await this.syncOwners(trx, actor.workspaceId);
      // creator is at least a member even if not a workspace owner
      const now = toDb(this.clock.now());
      await trx
        .insertInto('project_members')
        .values({ workspace_id: actor.workspaceId, project_id: id, user_id: actor.userId, role: 'owner', created_at: now, updated_at: now })
        .onConflict((oc) => oc.columns(['project_id', 'user_id']).doNothing())
        .execute();
      await this.assignDefaultAreaOwners(trx, actor.workspaceId);
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: id, actorUserId: actor.userId,
        entityType: 'project', entityId: id, action: 'project.created', data: { code, name },
      });
      return id;
    });
    return this.get(actor, id);
  }

  async update(
    actor: Actor,
    id: number,
    patch: Partial<{ name: string; description: string | null; status: ProjectStatus; repo_url: string | null; docs_url: string | null }>,
  ): Promise<Project> {
    await this.permissions.authorize(actor, 'project.update', { projectId: id });
    if (patch.status && !PROJECT_STATUSES.includes(patch.status)) throw new DomainError('project.bad_status');
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 60)) throw new DomainError('project.bad_name');
    for (const url of [patch.repo_url, patch.docs_url]) {
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new DomainError('project.bad_url');
    }
    const before = await this.get(actor, id);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(patch)) {
      const prev = before[k as keyof Project];
      if (v !== undefined && v !== prev) changes[k] = { from: prev, to: v };
    }
    if (Object.keys(changes).length === 0) return before;
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('projects').set({ ...patch, updated_at: toDb(this.clock.now()) }).where('id', '=', id).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: id, actorUserId: actor.userId,
        entityType: 'project', entityId: id, action: 'project.updated', data: { changes },
      });
    });
    return this.get(actor, id);
  }

  async setArchived(actor: Actor, id: number, archived: boolean): Promise<Project> {
    await this.permissions.authorize(actor, 'project.archive', { projectId: id });
    const p = await this.get(actor, id);
    if (p.is_general) throw new DomainError('project.general_fixed');
    if (Boolean(p.archived_at) === archived) return p; // idempotent
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('projects').set({ archived_at: archived ? now : null, updated_at: now }).where('id', '=', id).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: id, actorUserId: actor.userId,
        entityType: 'project', entityId: id, action: archived ? 'project.archived' : 'project.unarchived',
      });
    });
    return this.get(actor, id);
  }

  // ---------- areas ----------

  async area(actor: Actor, id: number): Promise<Area> {
    const a = await this.db.selectFrom('areas').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!a) throw new NotFoundError();
    await this.permissions.authorize(actor, 'project.view', { projectId: a.project_id });
    return a;
  }

  /** Applied by the 'areas.owner' approval (two-key) — never called directly from handlers. */
  async applyAreaOwner(actor: Actor, areaId: number, ownerUserId: number, requestedBy: number): Promise<void> {
    const a = await this.area(actor, areaId);
    if (!(await this.permissions.can({ userId: ownerUserId, workspaceId: actor.workspaceId }, 'project.view', { projectId: a.project_id }))) {
      throw new DomainError('task.owner_no_access');
    }
    await this.db.updateTable('areas').set({ owner_user_id: ownerUserId, updated_at: toDb(this.clock.now()) }).where('id', '=', areaId).execute();
    await this.events.record(this.db, {
      workspaceId: actor.workspaceId, projectId: a.project_id, actorUserId: actor.userId, entityType: 'area', entityId: areaId,
      action: 'area.owner_changed', data: { from: a.owner_user_id, to: ownerUserId, requestedBy },
    });
  }

  /** Backup, name and archive changes don't need a second key. */
  async updateArea(actor: Actor, areaId: number, patch: { backupUserId?: number | null; name?: string; archived?: boolean }): Promise<Area> {
    const a = await this.area(actor, areaId);
    await this.permissions.authorize(actor, 'area.manage', { projectId: a.project_id });
    const set: Record<string, unknown> = { updated_at: toDb(this.clock.now()) };
    if (patch.backupUserId !== undefined) set.backup_user_id = patch.backupUserId;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 40) throw new DomainError('area.bad_name');
      set.name = name;
    }
    if (patch.archived !== undefined) set.archived_at = patch.archived ? toDb(this.clock.now()) : null;
    await this.db.updateTable('areas').set(set).where('id', '=', areaId).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: a.project_id, actorUserId: actor.userId, entityType: 'area', entityId: areaId, action: 'area.updated', data: patch });
    return this.area(actor, areaId);
  }

  async addArea(actor: Actor, projectId: number, name: string): Promise<Area> {
    await this.permissions.authorize(actor, 'area.manage', { projectId });
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new DomainError('area.bad_name');
    const slug = slugify(clean);
    if (await this.db.selectFrom('areas').select('id').where('project_id', '=', projectId).where('slug', '=', slug).executeTakeFirst()) throw new DomainError('area.exists');
    const now = toDb(this.clock.now());
    const max = await this.db.selectFrom('areas').select((eb) => eb.fn.max('sort_order').as('m')).where('project_id', '=', projectId).executeTakeFirst();
    const row = await this.db.insertInto('areas').values({
      workspace_id: actor.workspaceId, project_id: projectId, name: clean, slug, owner_user_id: null, backup_user_id: null,
      sort_order: Number(max?.m ?? 0) + 1, archived_at: null, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId, entityType: 'area', entityId: row.id, action: 'area.created', data: { name: clean } });
    return row;
  }

  // ---------- internals ----------

  private async insertProject(
    exec: DbOrTx,
    workspaceId: number,
    p: { code: string; name: string; description: string | null; status: ProjectStatus; isGeneral: boolean; createdBy: number | null },
  ): Promise<number> {
    const now = toDb(this.clock.now());
    const r = await exec
      .insertInto('projects')
      .values({
        workspace_id: workspaceId, code: p.code, name: p.name, description: p.description, status: p.status,
        repo_url: null, docs_url: null, is_general: p.isGeneral ? 1 : 0, archived_at: null, created_by: p.createdBy,
        created_at: now, updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  }

  private async insertAreas(exec: DbOrTx, workspaceId: number, projectId: number, names: string[]): Promise<void> {
    const now = toDb(this.clock.now());
    for (const [i, name] of names.entries()) {
      await exec
        .insertInto('areas')
        .values({
          workspace_id: workspaceId, project_id: projectId, name, slug: slugify(name), owner_user_id: null,
          backup_user_id: null, sort_order: i, archived_at: null, created_at: now, updated_at: now,
        })
        .execute();
    }
  }
}
