import type { Db } from '../db/database.js';
import { toDb, type Clock } from '../time.js';

/**
 * Feature flags. Optional and AI features are OFF unless a row enables them.
 * Resolution: project flag → workspace flag → registered default.
 */
const defaults = new Map<string, boolean>();
export function defineFlag(key: string, defaultEnabled = false): string {
  defaults.set(key, defaultEnabled);
  return key;
}

export class FeatureFlags {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async isEnabled(workspaceId: number, key: string, projectId?: number): Promise<boolean> {
    if (projectId != null) {
      const p = await this.row(workspaceId, 'project', projectId, key);
      if (p !== undefined) return p;
    }
    const w = await this.row(workspaceId, 'workspace', workspaceId, key);
    if (w !== undefined) return w;
    return defaults.get(key) ?? false;
  }

  async set(workspaceId: number, key: string, enabled: boolean, projectId?: number): Promise<void> {
    const now = toDb(this.clock.now());
    const scope = projectId != null ? 'project' : 'workspace';
    const scopeId = projectId ?? workspaceId;
    await this.db
      .insertInto('feature_flags')
      .values({ workspace_id: workspaceId, scope, scope_id: scopeId, key, enabled: enabled ? 1 : 0, created_at: now, updated_at: now })
      .onConflict((oc) => oc.columns(['workspace_id', 'scope', 'scope_id', 'key']).doUpdateSet({ enabled: enabled ? 1 : 0, updated_at: now }))
      .execute();
  }

  private async row(workspaceId: number, scope: 'workspace' | 'project', scopeId: number, key: string): Promise<boolean | undefined> {
    const r = await this.db
      .selectFrom('feature_flags')
      .select('enabled')
      .where('workspace_id', '=', workspaceId)
      .where('scope', '=', scope)
      .where('scope_id', '=', scopeId)
      .where('key', '=', key)
      .executeTakeFirst();
    return r ? r.enabled === 1 : undefined;
  }
}
