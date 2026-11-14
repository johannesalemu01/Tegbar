import type { Db, DbOrTx } from '../db/database.js';
import type { SettingScope } from '../db/schema.js';
import { DomainError, ForbiddenError } from '../errors.js';
import { toDb, type Clock } from '../time.js';
import type { Actor } from './context.js';
import type { Hooks } from '../hooks.js';
import type { Permissions } from './permissions.js';

/**
 * Typed settings with defaults. Modules declare their settings with
 * `defineSetting` at import time; values live in the `settings` table as JSON.
 */
export interface SettingDef<T> {
  key: string;
  scope: SettingScope;
  default: T;
  validate: (v: unknown) => v is T;
}

const registry = new Map<string, SettingDef<unknown>>();

export function defineSetting<T>(def: SettingDef<T>): SettingDef<T> {
  const existing = registry.get(def.key);
  if (existing && existing.scope !== def.scope) throw new Error(`Setting ${def.key} defined twice`);
  registry.set(def.key, def as SettingDef<unknown>);
  return def;
}

export const isHHMM = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
export const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
export const isNullableId = (v: unknown): v is number | null => v === null || isPosInt(v);

// Core settings
export const S_CURRENT_PROJECT = defineSetting<number | null>({
  key: 'current_project_id', scope: 'user', default: null, validate: isNullableId,
});
export const S_TIME_FORMAT = defineSetting<'24h' | '12h'>({
  key: 'time_format', scope: 'user', default: '24h',
  validate: (v): v is '24h' | '12h' => v === '24h' || v === '12h',
});
export const S_DEFAULT_PROJECT = defineSetting<number | null>({
  key: 'default_project_id', scope: 'workspace', default: null, validate: isNullableId,
});
export const S_REGISTRATION_CLOSED = defineSetting<boolean>({
  key: 'registration_closed', scope: 'workspace', default: false, validate: isBool,
});

export class Settings {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly hooks?: Hooks,
  ) {}

  async get<T>(workspaceId: number, def: SettingDef<T>, scopeId: number, exec: DbOrTx = this.db): Promise<T> {
    const row = await exec
      .selectFrom('settings')
      .select('value')
      .where('workspace_id', '=', workspaceId)
      .where('scope', '=', def.scope)
      .where('scope_id', '=', scopeId)
      .where('key', '=', def.key)
      .executeTakeFirst();
    if (!row) return def.default;
    try {
      const v: unknown = JSON.parse(row.value);
      return def.validate(v) ? v : def.default;
    } catch {
      return def.default;
    }
  }

  /** Unchecked write — for bootstrap/system code only. User-facing code uses `setAs`. */
  async setSystem<T>(workspaceId: number, def: SettingDef<T>, scopeId: number, value: T, exec: DbOrTx = this.db): Promise<void> {
    if (!def.validate(value)) throw new DomainError('error.invalid_setting');
    const now = toDb(this.clock.now());
    await exec
      .insertInto('settings')
      .values({
        workspace_id: workspaceId, scope: def.scope, scope_id: scopeId, key: def.key,
        value: JSON.stringify(value), created_at: now, updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'scope', 'scope_id', 'key']).doUpdateSet({ value: JSON.stringify(value), updated_at: now }),
      )
      .execute();
  }

  async setAs<T>(actor: Actor, def: SettingDef<T>, scopeId: number, value: T): Promise<void> {
    if (def.scope === 'user') {
      if (scopeId !== actor.userId) throw new ForbiddenError();
      await this.permissions.authorize(actor, 'workspace.view');
    } else if (def.scope === 'workspace') {
      if (scopeId !== actor.workspaceId) throw new ForbiddenError();
      await this.permissions.authorize(actor, 'settings.workspace');
    } else {
      await this.permissions.authorize(actor, 'project.update', { projectId: scopeId });
    }
    await this.setSystem(actor.workspaceId, def, scopeId, value);
    await this.hooks?.emit('settings.changed', { workspaceId: actor.workspaceId, scope: def.scope, scopeId, key: def.key });
  }
}
