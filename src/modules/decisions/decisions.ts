import type { Generated, Kysely, Selectable } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { Db } from '../../core/db/database.js';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';
import { DomainError, NotFoundError } from '../../core/errors.js';
import type { Approvals } from '../../core/services/approvals.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog } from '../../core/services/events.js';
import type { Jobs } from '../../core/services/jobs.js';
import type { Members } from '../../core/services/members.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Purger } from '../../core/services/purge.js';
import type { SearchHit } from '../../core/services/search.js';
import { localDate, toDb, type Clock } from '../../core/time.js';

export type DecisionStatus = 'proposed' | 'agreed' | 'superseded';

/** The decision log: what, why, who agreed, project, date, status. */
export interface DecisionsTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  title: string;
  rationale: string | null;
  status: DecisionStatus;
  decided_on: string | null; // date it became agreed
  superseded_by: number | null;
  meeting_id: number | null;
  created_by: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface DecisionAgreementsTable {
  id: Generated<number>;
  workspace_id: number;
  decision_id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
}
export type DecisionRow = Selectable<DecisionsTable>;
declare module '../../core/db/schema.js' {
  interface DB {
    decisions: DecisionsTable;
    decision_agreements: DecisionAgreementsTable;
  }
}

export const decisionMigrations: Record<string, Migration> = {
  '202611150700_decisions_init': {
    async up(db: Kysely<any>) {
      await withStamps(withWorkspace(withId(db.schema.createTable('decisions')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('rationale', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('decided_on', 'text')
        .addColumn('superseded_by', 'integer')
        .addColumn('meeting_id', 'integer')
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('deleted_at', 'text')).execute();
      await withStamps(withWorkspace(withId(db.schema.createTable('decision_agreements')))
        .addColumn('decision_id', 'integer', (c) => c.notNull().references('decisions.id').onDelete('cascade'))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id'))
        .addUniqueConstraint('decision_agree_once', ['decision_id', 'user_id'])).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('decision_agreements').ifExists().execute();
      await db.schema.dropTable('decisions').ifExists().execute();
    },
  },
};

export interface DecisionView extends DecisionRow {
  project_code: string;
  agreed_by: number[];
}

export const DECISION_NOTIFY = 'decision.notify';

/**
 * A decision is *proposed* until every member who can see the project has
 * agreed (the proposer agrees by proposing). Agreed decisions are protected:
 * editing or deleting one needs another member's approval (two-key).
 */
export class DecisionService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly members: Members,
    private readonly approvals: Approvals,
    private readonly jobs: Jobs,
  ) {
    approvals.register<{ id: number; title?: string; rationale?: string | null; label: string }>({
      kind: 'decisions.edit', action: 'decision.create',
      describe: (p) => `Edit agreed decision: ${p.label}`,
      execute: async (decider, p) => this.applyEdit(decider, p.id, { title: p.title, rationale: p.rationale }),
    });
    approvals.register<{ id: number; label: string }>({
      kind: 'decisions.delete', action: 'decision.create',
      describe: (p) => `Delete agreed decision: ${p.label}`,
      execute: async (decider, p) => this.applyDelete(decider, p.id),
    });
  }

  private async voters(workspaceId: number, projectId: number): Promise<number[]> {
    const out: number[] = [];
    for (const m of await this.members.list(workspaceId)) {
      if (await this.permissions.can({ userId: m.user_id, workspaceId }, 'decision.create', { projectId })) out.push(m.user_id);
    }
    return out;
  }

  async propose(actor: Actor, i: { projectId: number; title: string; rationale?: string | null; meetingId?: number | null; agreedBy?: number[]; supersedes?: number | null }): Promise<DecisionView> {
    await this.permissions.authorize(actor, 'decision.create', { projectId: i.projectId });
    const title = i.title.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 200) throw new DomainError('decision.bad_title');
    if ((i.rationale ?? '').length > 2000) throw new DomainError('note.too_long');
    const now = toDb(this.clock.now());
    const id = await this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('decisions').values({
        workspace_id: actor.workspaceId, project_id: i.projectId, title, rationale: i.rationale?.trim() || null, status: 'proposed',
        decided_on: null, superseded_by: null, meeting_id: i.meetingId ?? null, created_by: actor.userId, deleted_at: null, created_at: now, updated_at: now,
      }).returning('id').executeTakeFirstOrThrow();
      for (const u of new Set([actor.userId, ...(i.agreedBy ?? [])])) {
        await trx.insertInto('decision_agreements').values({ workspace_id: actor.workspaceId, decision_id: r.id, user_id: u, created_at: now, updated_at: now })
          .onConflict((oc) => oc.columns(['decision_id', 'user_id']).doNothing()).execute();
      }
      await this.events.record(trx, { workspaceId: actor.workspaceId, projectId: i.projectId, actorUserId: actor.userId, entityType: 'decision', entityId: r.id, action: 'decision.proposed', data: { title, meetingId: i.meetingId ?? null } });
      return r.id;
    });
    await this.settle(actor.workspaceId, id);
    if (i.supersedes) await this.supersede(actor, i.supersedes, id);
    const d = await this.get(actor, id);
    if (d.status === 'proposed') {
      await this.jobs.upsert(actor.workspaceId, `decision:${id}:proposed`, { kind: DECISION_NOTIFY, payload: { decisionId: id, event: 'proposed' }, at: this.clock.now() });
    }
    return d;
  }

  /** Becomes agreed once every voter agreed. */
  private async settle(workspaceId: number, id: number): Promise<void> {
    const d = await this.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (d.status !== 'proposed') return;
    const agreed = new Set((await this.db.selectFrom('decision_agreements').select('user_id').where('decision_id', '=', id).execute()).map((r) => r.user_id));
    const voters = await this.voters(workspaceId, d.project_id);
    if (voters.every((v) => agreed.has(v))) {
      await this.db.updateTable('decisions').set({ status: 'agreed', decided_on: localDate(this.clock.now()), updated_at: toDb(this.clock.now()) }).where('id', '=', id).where('status', '=', 'proposed').execute();
      await this.events.record(this.db, { workspaceId, projectId: d.project_id, entityType: 'decision', entityId: id, action: 'decision.agreed' });
    }
  }

  /** Idempotent agree. */
  async agree(actor: Actor, id: number): Promise<{ decision: DecisionView; changed: boolean }> {
    const d = await this.get(actor, id);
    await this.permissions.authorize(actor, 'decision.create', { projectId: d.project_id });
    if (d.status !== 'proposed' || d.agreed_by.includes(actor.userId)) return { decision: d, changed: false };
    const now = toDb(this.clock.now());
    await this.db.insertInto('decision_agreements').values({ workspace_id: actor.workspaceId, decision_id: id, user_id: actor.userId, created_at: now, updated_at: now })
      .onConflict((oc) => oc.columns(['decision_id', 'user_id']).doNothing()).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: d.project_id, actorUserId: actor.userId, entityType: 'decision', entityId: id, action: 'decision.agree' });
    await this.settle(actor.workspaceId, id);
    const after = await this.get(actor, id);
    if (after.status === 'agreed') await this.jobs.upsert(actor.workspaceId, `decision:${id}:agreed`, { kind: DECISION_NOTIFY, payload: { decisionId: id, event: 'agreed', byUserId: actor.userId }, at: this.clock.now() });
    return { decision: after, changed: true };
  }

  async get(actor: Actor, id: number, includeDeleted = false): Promise<DecisionView> {
    const r = await this.db.selectFrom('decisions as d').innerJoin('projects as p', 'p.id', 'd.project_id').selectAll('d').select('p.code as project_code')
      .where('d.id', '=', id).where('d.workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!r || (r.deleted_at && !includeDeleted)) throw new NotFoundError();
    await this.permissions.authorize(actor, 'project.view', { projectId: r.project_id });
    const agreed = (await this.db.selectFrom('decision_agreements').select('user_id').where('decision_id', '=', id).orderBy('id').execute()).map((x) => x.user_id);
    return { ...r, agreed_by: agreed };
  }

  async byId(workspaceId: number, id: number): Promise<DecisionRow | undefined> {
    return this.db.selectFrom('decisions').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }

  async list(actor: Actor, f: { projectId?: number | null; status?: DecisionStatus | null }, page = 0, pageSize = 8) {
    const visible = await this.permissions.visibleProjectIds(actor);
    const ids = f.projectId ? visible.filter((v) => v === f.projectId) : visible;
    if (!ids.length) return { items: [] as (DecisionRow & { project_code: string })[], total: 0 };
    let q = this.db.selectFrom('decisions as d').innerJoin('projects as p', 'p.id', 'd.project_id')
      .where('d.workspace_id', '=', actor.workspaceId).where('d.project_id', 'in', ids).where('d.deleted_at', 'is', null);
    if (f.status) q = q.where('d.status', '=', f.status);
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('c')).executeTakeFirst())?.c ?? 0);
    const items = await q.selectAll('d').select('p.code as project_code').orderBy('d.id', 'desc').limit(pageSize).offset(page * pageSize).execute();
    return { items, total };
  }

  /** Proposed decisions edit directly; agreed ones need a second key. */
  async edit(actor: Actor, id: number, patch: { title?: string; rationale?: string | null }): Promise<{ applied: boolean; approvalId?: number }> {
    const d = await this.get(actor, id);
    await this.permissions.authorize(actor, 'decision.create', { projectId: d.project_id });
    if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 200)) throw new DomainError('decision.bad_title');
    if (d.status === 'proposed') {
      await this.applyEdit(actor, id, patch);
      return { applied: true };
    }
    if (d.status === 'superseded') throw new DomainError('decision.superseded');
    const a = await this.approvals.request(actor, 'decisions.edit', { id, ...patch, label: d.title }, d.project_id);
    return { applied: false, approvalId: a.id };
  }

  private async applyEdit(actor: Actor, id: number, patch: { title?: string; rationale?: string | null }): Promise<void> {
    const d = await this.byId(actor.workspaceId, id);
    if (!d || d.deleted_at) throw new DomainError('error.not_found');
    const set: Record<string, unknown> = { updated_at: toDb(this.clock.now()) };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.rationale !== undefined) set.rationale = patch.rationale?.trim() || null;
    await this.db.updateTable('decisions').set(set).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: d.project_id, actorUserId: actor.userId, entityType: 'decision', entityId: id, action: 'decision.edited', data: { from: { title: d.title, rationale: d.rationale }, to: patch } });
  }

  async remove(actor: Actor, id: number): Promise<{ applied: boolean; approvalId?: number }> {
    const d = await this.get(actor, id);
    await this.permissions.authorize(actor, 'decision.create', { projectId: d.project_id });
    if (d.status === 'proposed' && d.created_by === actor.userId) {
      await this.applyDelete(actor, id);
      return { applied: true };
    }
    const a = await this.approvals.request(actor, 'decisions.delete', { id, label: d.title }, d.project_id);
    return { applied: false, approvalId: a.id };
  }

  private async applyDelete(actor: Actor, id: number): Promise<void> {
    const d = await this.byId(actor.workspaceId, id);
    if (!d || d.deleted_at) return;
    await this.db.updateTable('decisions').set({ deleted_at: toDb(this.clock.now()), updated_at: toDb(this.clock.now()) }).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: d.project_id, actorUserId: actor.userId, entityType: 'decision', entityId: id, action: 'decision.deleted' });
  }

  private async supersede(actor: Actor, oldId: number, newId: number): Promise<void> {
    const old = await this.get(actor, oldId);
    if (old.status === 'superseded') return;
    await this.db.updateTable('decisions').set({ status: 'superseded', superseded_by: newId, updated_at: toDb(this.clock.now()) }).where('id', '=', oldId).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: old.project_id, actorUserId: actor.userId, entityType: 'decision', entityId: oldId, action: 'decision.superseded', data: { by: newId } });
  }

  async search(actor: Actor, pattern: string, limit: number): Promise<SearchHit[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    const rows = await this.db.selectFrom('decisions as d').innerJoin('projects as p', 'p.id', 'd.project_id')
      .select(['d.id', 'd.title', 'd.rationale', 'd.status', 'd.decided_on', 'd.created_at', 'p.code'])
      .where('d.workspace_id', '=', actor.workspaceId).where('d.project_id', 'in', visible).where('d.deleted_at', 'is', null)
      .where((eb) => eb.or([eb(eb.fn('lower', ['d.title']), 'like', pattern), eb(eb.fn('lower', ['d.rationale']), 'like', pattern)]))
      .orderBy('d.id', 'desc').limit(limit).execute();
    return rows.map((r) => ({ type: 'decision', id: r.id, title: r.title, snippet: r.status, date: r.decided_on ?? r.created_at, projectCode: r.code }));
  }

  purger(): Purger {
    return {
      type: 'decisions', label: 'deleted decisions', twoKey: true,
      candidates: async (actor) => {
        const visible = await this.permissions.visibleProjectIds(actor);
        if (!visible.length) return [];
        return (await this.db.selectFrom('decisions').select(['id', 'title']).where('workspace_id', '=', actor.workspaceId)
          .where('project_id', 'in', visible).where('deleted_at', 'is not', null).execute()).map((d) => ({ id: d.id, label: d.title }));
      },
      purge: async (actor, ids) => this.db.transaction().execute(async (trx) => {
        const r = await trx.deleteFrom('decisions').where('workspace_id', '=', actor.workspaceId).where('id', 'in', ids).where('deleted_at', 'is not', null).executeTakeFirst();
        await this.events.redact(trx, actor.workspaceId, 'decision', ids);
        await this.events.record(trx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'purge', action: 'purge.decisions', data: { count: Number(r.numDeletedRows) } });
        return { rows: Number(r.numDeletedRows), files: 0 };
      }),
    };
  }
}
