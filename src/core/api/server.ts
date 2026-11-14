import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import type { App } from '../../app.js';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.js';
import { t } from '../i18n/index.js';
import { validateInitData } from './initdata.js';
import { ApiRaw, ApiResponse, type ApiRouter } from './router.js';

export const API_PREFIX = '/api/v1';
const MAX_BODY = 64 * 1024;

export interface ApiOptions {
  botToken: string;
  maxAgeSec: number;
  corsOrigin?: string | undefined;
  /** requests per minute per member */
  rateLimit?: number;
  onError: (err: unknown, where: string) => Promise<void>;
}

/**
 * Returns a handler for node:http. Resolves to true if it handled the request.
 * Auth: `Authorization: tma <Telegram.WebApp.initData>`; the sender must be an
 * active workspace member. Everything else is the same domain layer the bot uses.
 */
export function createApiHandler(app: App, router: ApiRouter, opts: ApiOptions) {
  const hits = new Map<number, { windowStart: number; n: number }>();
  const limit = opts.rateLimit ?? 120;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (opts.corsOrigin) {
      headers['access-control-allow-origin'] = opts.corsOrigin;
      headers.vary = 'Origin';
    }
    res.writeHead(status, headers).end(status === 204 ? undefined : JSON.stringify(body));
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) return false;
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      if (!opts.corsOrigin) return send(res, 404, { error: 'not_found' }), true;
      res.writeHead(204, {
        'access-control-allow-origin': opts.corsOrigin,
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      }).end();
      return true;
    }

    try {
      // 1. Authenticate
      const auth = req.headers.authorization ?? '';
      const m = /^tma\s+(.+)$/i.exec(auth);
      if (!m) return send(res, 401, { error: 'unauthorized', message: 'Send Authorization: tma <initData>' }), true;
      const v = validateInitData(m[1]!, opts.botToken, { maxAgeSec: opts.maxAgeSec, nowSec: Math.floor(app.clock.now().toSeconds()) });
      if (!v.ok) return send(res, 401, { error: 'unauthorized', reason: v.error }), true;
      const found = await app.members.findByTelegramId(v.data.user.id);
      if (!found) return send(res, 403, { error: 'forbidden' }), true;
      const actor = { userId: found.user.id, workspaceId: found.member.workspace_id };

      // 2. Rate limit (in memory; fine for one process)
      const now = Date.now();
      const h = hits.get(actor.userId);
      if (!h || now - h.windowStart > 60_000) hits.set(actor.userId, { windowStart: now, n: 1 });
      else if (++h.n > limit) return send(res, 429, { error: 'rate_limited', retryAfterSec: 60 }), true;

      // 3. Route
      const route = router.match(method, url.pathname.slice(API_PREFIX.length));
      if (route === null) return send(res, 404, { error: 'not_found' }), true;
      if (route === 'method') return send(res, 405, { error: 'method_not_allowed' }), true;

      // 4. Body
      let body: unknown = undefined;
      if (method === 'POST' || method === 'PATCH') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'json_required' }), true;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return send(res, 413, { error: 'too_large' }), true;
          chunks.push(c as Buffer);
        }
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        } catch {
          return send(res, 400, { error: 'bad_json' }), true;
        }
      }

      const result = await route.handler({ app, actor, member: found.member, params: route.params, query: url.searchParams, body });
      if (result instanceof ApiRaw) {
        res.writeHead(result.status, {
          'content-type': result.contentType,
          'cache-control': 'no-store',
          ...(result.filename ? { 'content-disposition': `attachment; filename="${result.filename}"` } : {}),
          ...(opts.corsOrigin ? { 'access-control-allow-origin': opts.corsOrigin, vary: 'Origin' } : {}),
        }).end(result.body);
      } else if (result instanceof ApiResponse) send(res, result.status, result.body);
      else if (result === undefined) send(res, 204, null);
      else send(res, 200, result);
    } catch (err) {
      if (err instanceof ApiResponse) send(res, err.status, err.body);
      else if (err instanceof ZodError) send(res, 400, { error: 'bad_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      else if (err instanceof ForbiddenError) send(res, 403, { error: err.key, message: t(err.key) });
      else if (err instanceof NotFoundError) send(res, 404, { error: err.key, message: t(err.key) });
      else if (err instanceof DomainError) send(res, 400, { error: err.key, message: t(err.key, ...(err.params as [])).replace(/<[^>]+>/g, '') });
      else {
        await opts.onError(err, `api ${method} ${url.pathname}`);
        send(res, 500, { error: 'internal' });
      }
    }
    return true;
  };
}
