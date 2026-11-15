import { DomainError, ForbiddenError, NotFoundError } from '../errors.js';
import type { Db } from '../db/database.js';
import type { Approval } from '../db/schema.js';
import { toDb, type Clock } from '../time.js';
import type { Actor } from './context.js';
import type { EventLog } from './events.js';
import type { Jobs } from './jobs.js';
import type { Members } from './members.js';
import type { Action, Permissions } from './permissions.js';

/**
 * Generic two-key mechanism. A module registers an approval kind once:
 *
 *   approvals.register<P>({ kind: 'costs.split_rule', action: 'cost.manage',
 *     describe: (p) => '...', execute: async (decider, p, requester) => {...} })
 *
 * then calls `request(...)`. Another active member with the same permission
 * approves or rejects (exactly once). The requester can never approve their
 * own request. Notifications go through the outbox (`approval.notify` jobs),
 * so they are delivered once even with several processes.
 */
export interface ApprovalKind<P> {
  kind: string;
  /** Permission needed to request and to decide (checked on the project if given). */
  action: Action;
  describe: (payload: P) => string;
  execute: (decider: Actor, payload: P, requester: Actor, approvalId: number) => Promise<void>;
}

export const APPROVAL_NOTIFY = 'approval.notify';
export interface ApprovalNotifyPayload {
  approvalId: number;
  event: 'requested' | 'decided';
}

export class Approvals {
  private readonly kinds = new Map<string, ApprovalKind<any>>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly jobs: Jobs,
    private readonly members: Members,
  ) {}

  register<P>(k: ApprovalKind<P>): void {
    if (this.kinds.has(k.kind)) throw new Error(`Approval kind ${k.kind} registered twice`);
    this.kinds.set(k.kind, k);
  }

  private kind(name: string): ApprovalKind<unknown> {
    const k = this.kinds.get(name);
    if (!k) throw new Error(`Unknown approval kind ${name}`);
    return k;
  }

  async request<P>(actor: Actor, kind: string, payload: P, projectId: number | null = null): Promise<Approval> {
    const k = this.kind(kind);
    await this.permissions.authorize(actor, k.action, { projectId });
    const now = this.clock.now();
    const summary = k.describe(payload);
    // Idempotent: the same pending request (same person, kind, project and payload) is reused.
    const same = await this.db.selectFrom('approvals').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('kind', '=', kind).where('status', '=', 'pending')
      .where('requested_by', '=', actor.userId).where('project_id', projectId === null ? 'is' : '=', projectId)
      .where('payload', '=', JSON.stringify(payload)).where('expires_at', '>=', toDb(now))
      .executeTakeFirst();
    if (same) return same;
    const row = await this.db.transaction().execute(async (trx) => {
      // A newer request of the same kind for the same project replaces an older pending one.
      await trx.updateTable('approvals').set({ status: 'cancelled', updated_at: toDb(now) })
        .where('workspace_id', '=', actor.workspaceId).where('kind', '=', kind).where('status', '=', 'pending')
        .where('requested_by', '=', actor.userId).where('project_id', projectId === null ? 'is' : '=', projectId)
        .execute();
      const r = await trx.insertInto('approvals').values({
        workspace_id: actor.workspaceId, project_id: projectId, kind, payload: JSON.stringify(payload), summary,
        requested_by: actor.userId, status: 'pending', decided_by: null, decided_at: null, result: null,
        expires_at: toDb(now.plus({ days: 7 })), created_at: toDb(now), updated_at: toDb(now),
      }).returningAll().executeTakeFirstOrThrow();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId, entityType: 'approval', entityId: r.id,
        action: 'approval.requested', data: { kind, summary },
      });
      return r;
    });
    await this.jobs.upsert(actor.workspaceId, `approval:${row.id}:requested`, {
      kind: APPROVAL_NOTIFY, payload: { approvalId: row.id, event: 'requested' } satisfies ApprovalNotifyPayload, at: now,
    });
    return row;
  }

  async get(actor: Actor, id: number): Promise<Approval> {
    const r = await this.db.selectFrom('approvals').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError();
    if (!(await this.permissions.can(actor, 'workspace.view'))) throw new ForbiddenError();
    return r;
  }

  async byId(workspaceId: number, id: number): Promise<Approval | undefined> {
    return this.db.selectFrom('approvals').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }

  /** Approve or reject. Exactly once; never by the requester. */
  async decide(actor: Actor, id: number, approve: boolean): Promise<{ approval: Approval; changed: boolean }> {
    const a = await this.get(actor, id);
    const k = this.kind(a.kind);
    if (a.requested_by === actor.userId) throw new DomainError('approval.own_request');
    await this.permissions.authorize(actor, k.action, { projectId: a.project_id });
    const now = this.clock.now();
    if (a.status === 'pending' && a.expires_at < toDb(now)) {
      await this.db.updateTable('approvals').set({ status: 'expired', updated_at: toDb(now) }).where('id', '=', id).where('status', '=', 'pending').execute();
      return { approval: (await this.byId(actor.workspaceId, id))!, changed: false };
    }
    const r = await this.db.updateTable('approvals')
      .set({ status: approve ? 'approved' : 'rejected', decided_by: actor.userId, decided_at: toDb(now), updated_at: toDb(now) })
      .where('id', '=', id).where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return { approval: (await this.byId(actor.workspaceId, id))!, changed: false };

    if (approve) {
      try {
        await k.execute(actor, JSON.parse(a.payload), { userId: a.requested_by, workspaceId: a.workspace_id }, a.id);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        await this.db.updateTable('approvals').set({ status: 'failed', result: String(err.key), updated_at: toDb(now) }).where('id', '=', id).execute();
      }
    }
    const final = (await this.byId(actor.workspaceId, id))!;
    await this.events.record(this.db, {
      workspaceId: actor.workspaceId, projectId: a.project_id, actorUserId: actor.userId, entityType: 'approval', entityId: id,
      action: `approval.${final.status}`, data: { kind: a.kind },
    });
    await this.jobs.upsert(actor.workspaceId, `approval:${id}:decided`, {
      kind: APPROVAL_NOTIFY, payload: { approvalId: id, event: 'decided' } satisfies ApprovalNotifyPayload, at: now,
    });
    return { approval: final, changed: true };
  }

  async cancel(actor: Actor, id: number): Promise<{ changed: boolean }> {
    const a = await this.get(actor, id);
    if (a.requested_by !== actor.userId) throw new ForbiddenError();
    const r = await this.db.updateTable('approvals').set({ status: 'cancelled', updated_at: toDb(this.clock.now()) })
      .where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    return { changed: Number(r.numUpdatedRows) === 1 };
  }

  async pending(actor: Actor): Promise<Approval[]> {
    await this.permissions.authorize(actor, 'workspace.view');
    return this.db.selectFrom('approvals').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('status', '=', 'pending')
      .where('expires_at', '>=', toDb(this.clock.now()))
      .orderBy('id', 'desc').limit(20).execute();
  }

  /** Members (other than the requester) allowed to decide. */
  async approvers(a: Approval): Promise<Actor[]> {
    const k = this.kind(a.kind);
    const out: Actor[] = [];
    for (const m of await this.members.list(a.workspace_id)) {
      if (m.user_id === a.requested_by) continue;
      const actor = { userId: m.user_id, workspaceId: a.workspace_id };
      if (await this.permissions.can(actor, k.action, { projectId: a.project_id })) out.push(actor);
    }
    return out;
  }
}
