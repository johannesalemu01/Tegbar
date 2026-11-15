import type { Actor } from './context.js';

/**
 * Global search. Each module registers a provider; the service fans out and
 * merges. Matching is a plain case-insensitive substring (LIKE), which works
 * for Amharic (no case) and English, on SQLite and PostgreSQL alike.
 */
export interface SearchHit {
  type: string; // task | note | decision | notice | meeting | …
  id: number;
  title: string;
  snippet: string | null;
  date: string | null; // ISO or YYYY-MM-DD
  projectCode: string | null;
}

export type SearchProvider = (actor: Actor, pattern: string, limit: number) => Promise<SearchHit[]>;

/** Escape % and _ for LIKE ... ESCAPE '\\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class Search {
  private readonly providers = new Map<string, SearchProvider>();

  register(type: string, provider: SearchProvider): void {
    this.providers.set(type, provider);
  }

  types(): string[] {
    return [...this.providers.keys()];
  }

  async query(actor: Actor, q: string, opts: { types?: string[]; limitPerType?: number } = {}): Promise<SearchHit[]> {
    const clean = q.normalize('NFC').trim().toLowerCase();
    if (clean.length < 2) return [];
    const pattern = likePattern(clean);
    const out: SearchHit[] = [];
    for (const [type, p] of this.providers) {
      if (opts.types && !opts.types.includes(type)) continue;
      out.push(...(await p(actor, pattern, opts.limitPerType ?? 5)));
    }
    return out;
  }
}
