import { z } from 'zod';
import { ApiResponse, idParam, type ApiRouter } from '../../core/api/router.js';
import { isRecurrence } from './recurrence.js';
import { PRIORITIES, TASK_STATUSES } from './schema.js';
import type { TaskFilter, TaskView } from './service.js';

const due = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable() }).nullable();
const recurrence = z.unknown().refine((v) => v === null || isRecurrence(v), 'invalid recurrence');

const createBody = z.union([
  z.object({ text: z.string().min(1).max(500) }).strict(),
  z.object({
    projectId: z.number().int().positive(),
    title: z.string().min(1).max(200),
    notes: z.string().max(4000).nullable().optional(),
    ownerUserId: z.number().int().positive().nullable().optional(),
    priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
    areaId: z.number().int().positive().nullable().optional(),
    due: due.optional(),
    recurrence: recurrence.optional(),
  }).strict(),
]);

const patchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(4000).nullable().optional(),
  status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
  priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
  ownerUserId: z.number().int().positive().nullable().optional(),
  areaId: z.number().int().positive().nullable().optional(),
  projectId: z.number().int().positive().optional(),
  due: due.optional(),
  recurrence: recurrence.optional(),
}).strict();

/** Stable JSON shape for clients (camelCase, recurrence parsed). */
export function taskJson(t: TaskView) {
  return {
    id: t.id, ref: `T${t.id}`, projectId: t.project_id, projectCode: t.project_code, areaId: t.area_id, areaName: t.area_name,
    title: t.title, notes: t.notes, status: t.status, priority: t.priority, ownerUserId: t.owner_user_id, ownerName: t.owner_name,
    dueDate: t.due_date, dueAt: t.due_at, recurrence: t.recurrence ? JSON.parse(t.recurrence) : null,
    completedAt: t.completed_at, deletedAt: t.deleted_at, createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

function filterFrom(q: URLSearchParams): TaskFilter {
  const owner = q.get('owner') ?? 'me';
  const project = q.get('project') ?? 'all';
  const f = z.object({
    owner: z.union([z.literal('me'), z.literal('all'), z.coerce.number().int().positive()]),
    projectId: z.union([z.literal('all'), z.coerce.number().int().positive()]),
    status: z.enum(['open', 'blocked', 'done', 'all']),
    due: z.enum(['any', 'today', 'week', 'overdue']),
  }).parse({ owner, projectId: project, status: q.get('status') ?? 'open', due: q.get('due') ?? 'any' });
  return {
    owner: f.owner, projectId: f.projectId === 'all' ? null : f.projectId, status: f.status, due: f.due,
    ...(q.get('recurring') === '1' ? { recurring: true } : {}),
  };
}

export function tasksApi(r: ApiRouter): void {
  r.get('/tasks', async ({ app, actor, query }) => {
    const page = z.coerce.number().int().min(0).max(1000).parse(query.get('page') ?? '0');
    const pageSize = z.coerce.number().int().min(1).max(100).parse(query.get('pageSize') ?? '25');
    const { items, total } = await app.tasks.list(actor, filterFrom(query), page, pageSize);
    return { items: items.map(taskJson), total, page, pageSize };
  });
  r.get('/tasks/:id', async (req) => taskJson(await req.app.tasks.get(req.actor, idParam(req), { includeDeleted: true })));
  r.get('/tasks/:id/history', async (req) =>
    (await req.app.tasks.history(req.actor, idParam(req))).map((e) => ({
      at: e.created_at, actorUserId: e.actor_user_id, action: e.action, data: JSON.parse(e.data),
    })),
  );
  r.post('/tasks', async ({ app, actor, body }) => {
    const b = createBody.parse(body);
    if ('text' in b) {
      // Same quick-add parser as the bot; ambiguities are returned, not guessed.
      const parsed = await app.tasks.parse(actor, b.text);
      if (parsed.issues.length) return new ApiResponse(422, { error: 'ambiguous', parsed });
      const task = await app.tasks.create(actor, {
        projectId: parsed.projectId, title: parsed.title, ownerUserId: parsed.ownerUserId, priority: parsed.priority,
        areaId: parsed.areaId, due: parsed.due, recurrence: parsed.recurrence,
      });
      return new ApiResponse(201, taskJson(task));
    }
    const task = await app.tasks.create(actor, b as Parameters<typeof app.tasks.create>[1]);
    return new ApiResponse(201, taskJson(task));
  });
  r.patch('/tasks/:id', async (req) => {
    const patch = patchBody.parse(req.body);
    const { task, changed, spawned } = await req.app.tasks.update(req.actor, idParam(req), patch as Parameters<typeof req.app.tasks.update>[2]);
    return { task: taskJson(task), changed, spawned: spawned ? taskJson(spawned) : null };
  });
  r.delete('/tasks/:id', async (req) => {
    await req.app.tasks.remove(req.actor, idParam(req));
    return undefined;
  });
  r.post('/tasks/:id/restore', async (req) => taskJson((await req.app.tasks.restore(req.actor, idParam(req))).task));
  r.get('/dashboard', async ({ app, actor }) => ({
    projects: await app.tasks.stats(actor),
    people: await app.tasks.personCounts(actor),
  }));
}
