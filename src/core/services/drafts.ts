import type { Db } from '../db/database.js';
import { toDb, type Clock } from '../time.js';

/**
 * Drafts back confirmation cards. `consume` is atomic, so a "Save" button
 * tapped twice (or after a restart) creates the item exactly once.
 */
export class Drafts {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async create<T>(workspaceId: number, userId: number, kind: string, payload: T, ttlHours = 48): Promise<number> {
    const now = this.clock.now();
    const r = await this.db
      .insertInto('drafts')
      .values({
        workspace_id: workspaceId, user_id: userId, kind, payload: JSON.stringify(payload),
        expires_at: toDb(now.plus({ hours: ttlHours })), consumed_at: null,
        created_at: toDb(now), updated_at: toDb(now),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  }

  /** Returns the payload if the draft exists, belongs to the user, and is still open. */
  async get<T>(id: number, userId: number, kind: string): Promise<{ payload: T; consumed: boolean } | null> {
    const r = await this.db
      .selectFrom('drafts')
      .select(['payload', 'consumed_at', 'expires_at'])
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .executeTakeFirst();
    if (!r) return null;
    if (r.expires_at < toDb(this.clock.now()) && !r.consumed_at) return null;
    return { payload: JSON.parse(r.payload) as T, consumed: r.consumed_at !== null };
  }

  async update<T>(id: number, userId: number, payload: T): Promise<boolean> {
    const r = await this.db
      .updateTable('drafts')
      .set({ payload: JSON.stringify(payload), updated_at: toDb(this.clock.now()) })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  /** Atomically marks the draft consumed. Only the first caller gets `true`. */
  async consume(id: number, userId: number): Promise<boolean> {
    const now = toDb(this.clock.now());
    const r = await this.db
      .updateTable('drafts')
      .set({ consumed_at: now, updated_at: now })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>=', now)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  async purgeExpired(): Promise<void> {
    const cutoff = toDb(this.clock.now().minus({ days: 7 }));
    await this.db.deleteFrom('drafts').where('expires_at', '<', cutoff).execute();
  }
}
