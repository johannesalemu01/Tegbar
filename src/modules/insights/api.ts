import { z } from 'zod';
import { ApiResponse, idParam, type ApiRouter } from '../../core/api/router.js';
import { ForbiddenError } from '../../core/errors.js';
import { FLAG_BRIEF, FLAG_WINS, FLAG_WORKLOAD } from './service.js';

export function insightsApi(r: ApiRouter): void {
  const gate = async (app: Parameters<Parameters<ApiRouter['get']>[1]>[0]['app'], ws: number, flag: string) => {
    if (!(await app.flags.isEnabled(ws, flag))) throw new ForbiddenError();
  };
  r.get('/brief', async ({ app, actor }) => {
    await gate(app, actor.workspaceId, FLAG_BRIEF);
    const d = await app.insights.brief(actor);
    return { ...d, done: d.done.map((x) => ({ id: x.id, title: x.title, ownerUserId: x.owner_user_id })), stuck: d.stuck.map((x) => ({ id: x.id, title: x.title, status: x.status, ownerName: x.owner_name })), meetingsNext: d.meetingsNext.map((m) => ({ id: m.id, title: m.title, startAt: m.startAt, mode: m.mode })) };
  });
  r.get('/workload', async ({ app, actor }) => {
    await gate(app, actor.workspaceId, FLAG_WORKLOAD);
    return app.insights.workload(actor);
  });
  r.get('/wins', async ({ app, actor }) => {
    await gate(app, actor.workspaceId, FLAG_WINS);
    return { wins: await app.insights.wins(actor), streak: await app.insights.streak(actor) };
  });
  r.post('/wins', async ({ app, actor, body }) => {
    await gate(app, actor.workspaceId, FLAG_WINS);
    const b = z.object({ text: z.string().min(1).max(300), projectId: z.number().int().positive().nullable().optional() }).strict().parse(body);
    return new ApiResponse(201, await app.insights.addWin(actor, b.text, b.projectId ?? null));
  });
  r.delete('/wins/:id', async (req) => {
    await req.app.insights.deleteWin(req.actor, idParam(req));
    return undefined;
  });
}
