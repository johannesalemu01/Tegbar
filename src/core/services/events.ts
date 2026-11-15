import { toDb, type Clock } from '../time.js';
import type { DbOrTx } from '../db/database.js';
import type { Selectable } from 'kysely';
import type { EventsTable } from '../db/schema.js';

export interface EventInput {
  workspaceId: number;
  projectId?: number | null;
  actorUserId?: number | null;
  entityType: string;
  entityId?: number | null;
  action: string;
  data?: Record<string, unknown>;
}

export type EventRow = Selectable<EventsTable>;

/**
 * Append-only audit log. There is no update or delete — with one exception:
 * `redact()`, used only by /purge, blanks the `data` of events about purged
 * items (so deleted content does not survive in history). The redaction itself
 * is recorded as a new event.
 */
export class EventLog {
  constructor(private readonly clock: Clock) {}

  async record(exec: DbOrTx, e: EventInput): Promise<void> {
    const now = toDb(this.clock.now());
    await exec
      .insertInto('events')
      .values({
        workspace_id: e.workspaceId,
        project_id: e.projectId ?? null,
        actor_user_id: e.actorUserId ?? null,
        entity_type: e.entityType,
        entity_id: e.entityId ?? null,
        action: e.action,
        data: JSON.stringify(e.data ?? {}),
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async redact(exec: DbOrTx, workspaceId: number, entityType: string, entityIds: number[]): Promise<number> {
    if (entityIds.length === 0) return 0;
    const r = await exec
      .updateTable('events')
      .set({ data: '{"redacted":true}', updated_at: toDb(this.clock.now()) })
      .where('workspace_id', '=', workspaceId)
      .where('entity_type', '=', entityType)
      .where('entity_id', 'in', entityIds)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  async forEntity(exec: DbOrTx, workspaceId: number, entityType: string, entityId: number, limit = 20): Promise<EventRow[]> {
    return exec
      .selectFrom('events')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  async lastByActor(exec: DbOrTx, workspaceId: number, actorUserId: number, actions: string[], sinceIso: string): Promise<EventRow[]> {
    return exec
      .selectFrom('events')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('actor_user_id', '=', actorUserId)
      .where('action', 'in', actions)
      .where('created_at', '>=', sinceIso)
      .orderBy('id', 'desc')
      .limit(20)
      .execute();
  }
}
