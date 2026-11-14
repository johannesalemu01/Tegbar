import type { Db } from '../db/database.js';
import type { Workspace } from '../db/schema.js';
import { toDb, type Clock } from '../time.js';

export class Workspaces {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** One workspace today; the schema already supports many. */
  async ensureDefault(name: string, timezone: string): Promise<Workspace> {
    const existing = await this.db.selectFrom('workspaces').selectAll().orderBy('id').executeTakeFirst();
    if (existing) return existing;
    const now = toDb(this.clock.now());
    return this.db
      .insertInto('workspaces')
      .values({ name, timezone, created_at: now, updated_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
