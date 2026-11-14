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
 * Append-only audit log. There is intentionally no update or delete here.
 * (Phase 5 /purge will redact `data` through a dedicated, logged path.)
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
