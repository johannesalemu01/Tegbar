import type { DateTime } from 'luxon';
import type { Db } from '../db/database.js';
import type { FireStatus, Job } from '../db/schema.js';
import { toDb, type Clock } from '../time.js';

export interface JobSpec<P = unknown> {
  kind: string;
  userId?: number | null;
  payload: P;
  at: DateTime;
}

/**
 * Persistent job store. Jobs are identified by a stable `key` so domain code
 * can say "make sure this reminder exists at time T" (upsert) or "this
 * reminder is no longer needed" (cancel) without tracking ids.
 */
export class Jobs {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async upsert<P>(workspaceId: number, key: string, spec: JobSpec<P>): Promise<void> {
    const now = toDb(this.clock.now());
    const values = {
      kind: spec.kind,
      user_id: spec.userId ?? null,
      payload: JSON.stringify(spec.payload),
      next_fire_at: toDb(spec.at),
      status: 'active' as const,
      updated_at: now,
    };
    await this.db
      .insertInto('jobs')
      .values({ workspace_id: workspaceId, key, fire_count: 0, last_fired_at: null, created_at: now, ...values })
      .onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet(values))
      .execute();
  }

  async get(workspaceId: number, key: string): Promise<Job | undefined> {
    return this.db.selectFrom('jobs').selectAll().where('workspace_id', '=', workspaceId).where('key', '=', key).executeTakeFirst();
  }

  async activeByPrefix(workspaceId: number, prefix: string): Promise<Job[]> {
    return this.db
      .selectFrom('jobs').selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'active')
      .where('key', 'like', `${prefix.replace(/[%_]/g, '\\$&')}%`)
      .execute();
  }

  async cancel(workspaceId: number, key: string): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({ status: 'cancelled', next_fire_at: null, updated_at: toDb(this.clock.now()) })
      .where('workspace_id', '=', workspaceId)
      .where('key', '=', key)
      .where('status', '=', 'active')
      .execute();
  }

  async cancelPrefix(workspaceId: number, prefix: string, keep: string[] = []): Promise<void> {
    for (const j of await this.activeByPrefix(workspaceId, prefix)) {
      if (!keep.includes(j.key)) await this.cancel(workspaceId, j.key);
    }
  }

  async due(now: DateTime, limit = 100): Promise<Job[]> {
    return this.db
      .selectFrom('jobs').selectAll()
      .where('status', '=', 'active')
      .where('next_fire_at', '<=', toDb(now))
      .orderBy('next_fire_at')
      .orderBy('id')
      .limit(limit)
      .execute();
  }

  /**
   * Atomically claim the fire of `job` at its current next_fire_at and move the
   * job on. Returns the fire id, or null if someone else already handled this
   * moment or the job changed meanwhile (re-planned, cancelled).
   */
  async claim(
    job: Job,
    outcome: { status: FireStatus; detail?: string; next: DateTime | null; payload?: unknown; counted: boolean },
  ): Promise<number | null> {
    const fireAt = job.next_fire_at;
    if (!fireAt) return null;
    const now = toDb(this.clock.now());
    return this.db.transaction().execute(async (trx) => {
      const moved = await trx
        .updateTable('jobs')
        .set({
          next_fire_at: outcome.next ? toDb(outcome.next) : null,
          status: outcome.next ? 'active' : 'done',
          payload: outcome.payload === undefined ? job.payload : JSON.stringify(outcome.payload),
          fire_count: outcome.counted ? job.fire_count + 1 : job.fire_count,
          last_fired_at: outcome.counted ? now : job.last_fired_at,
          updated_at: now,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'active')
        .where('next_fire_at', '=', fireAt)
        .executeTakeFirst();
      if (Number(moved.numUpdatedRows) !== 1) return null;
      const fire = await trx
        .insertInto('job_fires')
        .values({
          workspace_id: job.workspace_id, job_id: job.id, fire_at: fireAt, status: outcome.status,
          detail: outcome.detail ?? null, created_at: now, updated_at: now,
        })
        .onConflict((oc) => oc.columns(['job_id', 'fire_at']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!fire) {
        // This exact moment was already fired before (e.g. re-planned to the same time). Keep the job moved on.
        return null;
      }
      return fire.id;
    });
  }

  async finishFire(fireId: number, status: FireStatus, detail?: string): Promise<void> {
    await this.db
      .updateTable('job_fires')
      .set({ status, detail: detail ?? null, updated_at: toDb(this.clock.now()) })
      .where('id', '=', fireId)
      .execute();
  }

  /** Housekeeping: forget fire records and finished jobs older than `days`. */
  async prune(days = 30): Promise<void> {
    const cutoff = toDb(this.clock.now().minus({ days }));
    await this.db.deleteFrom('job_fires').where('created_at', '<', cutoff).execute();
    await this.db.deleteFrom('jobs').where('status', '!=', 'active').where('updated_at', '<', cutoff).execute();
  }
}
