import type { Logger } from 'pino';
import type { SettingScope } from './db/schema.js';

/**
 * In-process domain events, emitted AFTER a change is committed. Modules
 * subscribe to react to each other without importing each other
 * (e.g. reminders re-plan jobs when a task changes).
 * For audit history use the append-only `events` table instead.
 */
export interface HookEvents {
  'task.changed': { workspaceId: number; taskId: number };
  'member.paired': { workspaceId: number; userId: number };
  'settings.changed': { workspaceId: number; scope: SettingScope; scopeId: number; key: string };
}

type Listener<K extends keyof HookEvents> = (payload: HookEvents[K]) => Promise<void> | void;

export class Hooks {
  private readonly listeners = new Map<keyof HookEvents, Listener<any>[]>();
  constructor(private readonly log: Logger) {}

  on<K extends keyof HookEvents>(event: K, fn: Listener<K>): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  /** Runs listeners in order. A failing listener is logged and never breaks the caller. */
  async emit<K extends keyof HookEvents>(event: K, payload: HookEvents[K]): Promise<void> {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        await fn(payload);
      } catch (err) {
        this.log.error({ err, event }, 'hook listener failed');
      }
    }
  }
}
