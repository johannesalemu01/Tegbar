import type { Actor } from './context.js';

/** Data export registry: each module exports its own rows (only what the actor may see). */
export type ExportRows = Record<string, string | number | null>[];
export type ExportSource = (actor: Actor) => Promise<ExportRows>;

export class Exporter {
  private readonly sources = new Map<string, ExportSource>();
  register(name: string, fn: ExportSource): void {
    this.sources.set(name, fn);
  }
  names(): string[] {
    return [...this.sources.keys()];
  }
  async rows(actor: Actor, name: string): Promise<ExportRows> {
    const fn = this.sources.get(name);
    return fn ? fn(actor) : [];
  }
  async all(actor: Actor): Promise<Record<string, ExportRows>> {
    const out: Record<string, ExportRows> = {};
    for (const n of this.names()) out[n] = await this.rows(actor, n);
    return out;
  }
}
