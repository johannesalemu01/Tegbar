import type { Db } from '../db/database.js';
import { toDb, type Clock } from '../time.js';

/**
 * "The next text message from this user answers question <kind>."
 * Stored in the database so a restart never loses or confuses a flow.
 */
export interface PendingInput<T = unknown> {
  kind: string;
  payload: T;
}

export class PendingInputs {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async set<T>(workspaceId: number, userId: number, kind: string, payload: T, ttlMinutes = 30): Promise<void> {
    const now = this.clock.now();
    const values = {
      kind, payload: JSON.stringify(payload), expires_at: toDb(now.plus({ minutes: ttlMinutes })), updated_at: toDb(now),
    };
    await this.db
      .insertInto('pending_inputs')
      .values({ workspace_id: workspaceId, user_id: userId, created_at: toDb(now), ...values })
      .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doUpdateSet(values))
      .execute();
  }

  /** Returns and removes the pending input (if still valid). */
  async take<T>(workspaceId: number, userId: number): Promise<PendingInput<T> | null> {
    const row = await this.db
      .deleteFrom('pending_inputs')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .returning(['kind', 'payload', 'expires_at'])
      .executeTakeFirst();
    if (!row || row.expires_at < toDb(this.clock.now())) return null;
    return { kind: row.kind, payload: JSON.parse(row.payload) as T };
  }

  async clear(workspaceId: number, userId: number): Promise<void> {
    await this.db.deleteFrom('pending_inputs').where('workspace_id', '=', workspaceId).where('user_id', '=', userId).execute();
  }
}
