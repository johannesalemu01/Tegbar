import { DomainError } from '../errors.js';
import type { Actor } from './context.js';
import type { Approvals } from './approvals.js';
import type { Permissions } from './permissions.js';

/**
 * /purge — permanent deletion of items that are ALREADY soft-deleted,
 * archived or voided (two steps, never one). Modules register purgeable types.
 * Money and decisions are "important": purging them needs a second key.
 * Purging also removes files (receipts) and redacts the items' history.
 * Existing backups are not touched (they rotate out; see README).
 */
export interface Purger {
  type: string;
  label: string;
  /** needs another owner's approval */
  twoKey: boolean;
  candidates(actor: Actor): Promise<{ id: number; label: string }[]>;
  /** Permanently delete; must re-check that each id is still purgeable. Returns rows and files removed. */
  purge(actor: Actor, ids: number[]): Promise<{ rows: number; files: number }>;
}

export class Purge {
  private readonly purgers = new Map<string, Purger>();

  constructor(private readonly permissions: Permissions, private readonly approvals: Approvals) {
    approvals.register<{ type: string; ids: number[]; label: string }>({
      kind: 'purge.items',
      action: 'data.purge',
      describe: (p) => `Permanently delete ${p.ids.length} × ${p.label}`,
      execute: async (decider, p) => {
        await this.get(p.type).purge(decider, p.ids);
      },
    });
  }

  register(p: Purger): void {
    this.purgers.set(p.type, p);
  }

  list(): Purger[] {
    return [...this.purgers.values()];
  }

  get(type: string): Purger {
    const p = this.purgers.get(type);
    if (!p) throw new DomainError('purge.unknown_type');
    return p;
  }

  /** Runs now (confirmation-only types) or asks for a second key. */
  async run(actor: Actor, type: string, ids: number[]): Promise<{ done: boolean; rows: number; files: number; approvalId?: number }> {
    await this.permissions.authorize(actor, 'data.purge');
    const p = this.get(type);
    const allowed = new Set((await p.candidates(actor)).map((c) => c.id));
    const chosen = [...new Set(ids)].filter((id) => allowed.has(id));
    if (chosen.length === 0) throw new DomainError('purge.nothing');
    if (p.twoKey) {
      const a = await this.approvals.request(actor, 'purge.items', { type, ids: chosen, label: p.label });
      return { done: false, rows: 0, files: 0, approvalId: a.id };
    }
    const r = await p.purge(actor, chosen);
    return { done: true, ...r };
  }
}
