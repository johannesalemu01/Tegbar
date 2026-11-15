import { z } from 'zod';
import { ApiResponse, idParam, type ApiRouter } from '../../core/api/router.js';
import { LEVELS } from '../comms/service.js';

/** Phase 5 routes: search, notes, decisions, notices, messages. Same domain services as the bot. */
export function knowledgeApi(r: ApiRouter): void {
  r.get('/search', async ({ app, actor, query }) => app.search.query(actor, query.get('q') ?? '', { limitPerType: 10 }));

  r.get('/notes', async ({ app, actor, query }) => (await app.notes.list(actor, { tag: query.get('tag'), projectId: query.get('project') ? Number(query.get('project')) : null }, 0, 200)).items);
  r.post('/notes', async ({ app, actor, body }) => {
    const b = z.object({ projectId: z.number().int().positive(), title: z.string().min(1).max(120), body: z.string().max(4000).nullable().optional(), url: z.string().url().nullable().optional(), tags: z.array(z.string().max(30)).max(10).optional() }).strict().parse(body);
    return new ApiResponse(201, await app.notes.create(actor, b));
  });

  r.get('/decisions', async ({ app, actor, query }) => {
    const status = z.enum(['proposed', 'agreed', 'superseded']).nullable().parse(query.get('status'));
    return (await app.decisions.list(actor, { status }, 0, 200)).items;
  });
  r.get('/decisions/:id', async (req) => req.app.decisions.get(req.actor, idParam(req)));
  r.post('/decisions', async ({ app, actor, body }) => {
    const b = z.object({ projectId: z.number().int().positive(), title: z.string().min(1).max(200), rationale: z.string().max(2000).nullable().optional() }).strict().parse(body);
    return new ApiResponse(201, await app.decisions.propose(actor, b));
  });
  r.post('/decisions/:id/agree', async (req) => (await req.app.decisions.agree(req.actor, idParam(req))).decision);

  r.get('/notices', async ({ app, actor, query }) => app.comms.list(actor, query.get('archived') === '1', 50));
  r.post('/notices', async ({ app, actor, body }) => {
    const b = z.object({ projectId: z.number().int().positive(), level: z.enum(LEVELS as [string, ...string[]]), body: z.string().min(1).max(2000) }).strict().parse(body);
    return new ApiResponse(201, await app.comms.post(actor, b as never));
  });
  r.post('/notices/:id/ack', async (req) => (await req.app.comms.ack(req.actor, idParam(req))).notice);
  r.post('/messages', async ({ app, actor, body }) => {
    const b = z.object({ toUserId: z.number().int().positive(), body: z.string().min(1).max(3000) }).strict().parse(body);
    return new ApiResponse(201, await app.comms.tell(actor, b.toUserId, b.body));
  });
}
