import type { App } from '../../app.js';
import type { Member } from '../db/schema.js';
import type { Actor } from '../services/context.js';

export interface ApiRequest {
  app: App;
  actor: Actor;
  member: Member;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export class ApiResponse {
  constructor(readonly status: number, readonly body: unknown) {}
}

/** A non-JSON response (e.g. text/calendar). */
export class ApiRaw {
  constructor(readonly status: number, readonly contentType: string, readonly body: string, readonly filename?: string) {}
}

export type ApiHandler = (req: ApiRequest) => Promise<unknown>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface Route {
  method: Method;
  parts: string[];
  handler: ApiHandler;
}

/**
 * Tiny path router: "/tasks/:id/history". Handlers only translate HTTP ⇄ domain
 * calls; permission checks happen inside the domain services, exactly as for
 * Telegram handlers.
 */
export class ApiRouter {
  private readonly routes: Route[] = [];

  get(path: string, h: ApiHandler) { this.add('GET', path, h); }
  post(path: string, h: ApiHandler) { this.add('POST', path, h); }
  patch(path: string, h: ApiHandler) { this.add('PATCH', path, h); }
  delete(path: string, h: ApiHandler) { this.add('DELETE', path, h); }

  private add(method: Method, path: string, handler: ApiHandler) {
    const parts = path.split('/').filter(Boolean);
    if (this.routes.some((r) => r.method === method && r.parts.join('/') === parts.join('/'))) {
      throw new Error(`API route ${method} ${path} registered twice`);
    }
    this.routes.push({ method, parts, handler });
  }

  match(method: string, path: string): { handler: ApiHandler; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let pathMatched = false;
    let best: { handler: ApiHandler; params: Record<string, string>; literals: number } | null = null;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let literals = 0;
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(':')) {
          params[p.slice(1)] = decodeURIComponent(segs[i]!);
          return true;
        }
        literals++;
        return p === segs[i];
      });
      if (!ok) continue;
      pathMatched = true;
      // The most specific route wins: /costs/summary beats /costs/:id regardless of registration order.
      if (r.method === method && (!best || literals > best.literals)) best = { handler: r.handler, params, literals };
    }
    if (best) return { handler: best.handler, params: best.params };
    return pathMatched ? 'method' : null;
  }

  list(): string[] {
    return this.routes.map((r) => `${r.method} /${r.parts.join('/')}`);
  }
}

/** Parse a positive integer route param or throw a 400. */
export function idParam(req: ApiRequest, name = 'id'): number {
  const n = Number(req.params[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ApiResponse(400, { error: 'bad_id', message: `Invalid ${name}` });
  return n;
}
