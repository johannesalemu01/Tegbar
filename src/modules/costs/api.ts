import { z } from 'zod';
import { ApiRaw, ApiResponse, idParam, type ApiRouter } from '../../core/api/router.js';
import { localDate } from '../../core/time.js';
import { statementCsv } from './exports.js';
import { METHODS, SPLITS, TAGS } from './parse.js';
import type { CostView } from './service.js';

export function costJson(c: CostView) {
  return {
    id: c.id, ref: `C${c.id}`, projectId: c.project_id, projectCode: c.project_code, categoryId: c.category_id, categoryName: c.category_name,
    amountMinor: c.amount_minor, currency: c.currency, rateMicro: c.rate_micro, date: c.spent_on, paidBy: c.paid_by, payerName: c.payer_name,
    method: c.method, founderTag: c.founder_tag, splitMode: c.split_mode, note: c.note, status: c.status, voidReason: c.void_reason,
    splits: c.splits.map((s) => ({ userId: s.userId, name: s.name, bp: s.bp, amountMinor: s.amount })), receiptCount: c.receipt_count,
    createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

const money = z.number().int().positive();
const createBody = z.object({
  projectId: z.number().int().positive(), categoryId: z.number().int().positive(), amountMinor: money, currency: z.string().regex(/^[A-Z]{3}$/),
  rateMicro: z.number().int().positive().nullable().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), paidBy: z.number().int().positive(),
  method: z.enum(METHODS as [string, ...string[]]), founderTag: z.enum(TAGS as [string, ...string[]]).default('expense'),
  splitMode: z.enum(SPLITS as [string, ...string[]]).default('rule'), note: z.string().max(300).nullable().optional(),
}).strict();

export function costsApi(r: ApiRouter): void {
  r.get('/costs', async ({ app, actor, query }) => {
    const month = query.get('month') ?? undefined;
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new ApiResponse(400, { error: 'bad_month' });
    const project = query.get('project');
    const page = z.coerce.number().int().min(0).parse(query.get('page') ?? '0');
    const { items, total } = await app.costs.list(actor, { month: month ?? null, projectId: project ? Number(project) : null, includeVoided: query.get('voided') === '1' }, page, 50);
    return { items: items.map(costJson), total, page };
  });
  r.get('/costs/:id', async (req) => costJson(await req.app.costs.get(req.actor, idParam(req))));
  r.post('/costs', async ({ app, actor, body }) => {
    const b = createBody.parse(body);
    const { cost, needsApproval } = await app.costs.create(actor, {
      projectId: b.projectId, categoryId: b.categoryId, amount: b.amountMinor, currency: b.currency, rateMicro: b.rateMicro ?? null, date: b.date,
      paidBy: b.paidBy, method: b.method as never, tag: b.founderTag as never, split: b.splitMode as never, note: b.note ?? null,
    });
    return new ApiResponse(201, { ...costJson(cost), needsApproval });
  });
  r.patch('/costs/:id', async (req) => {
    const b = createBody.partial().omit({ currency: true }).strict().parse(req.body);
    const { cost, changed } = await req.app.costs.edit(req.actor, idParam(req), {
      projectId: b.projectId, categoryId: b.categoryId, amount: b.amountMinor, rateMicro: b.rateMicro, date: b.date, paidBy: b.paidBy,
      method: b.method as never, tag: b.founderTag as never, split: b.splitMode as never, note: b.note,
    });
    return { cost: costJson(cost), changed };
  });
  r.post('/costs/:id/void', async (req) => {
    const b = z.object({ reason: z.string().min(3).max(300) }).strict().parse(req.body);
    const { cost, changed } = await req.app.costs.void(req.actor, idParam(req), b.reason);
    return { cost: costJson(cost), changed };
  });
  r.get('/categories', async ({ app, actor }) => (await app.costs.categories(actor)).map((c) => ({ id: c.id, name: c.name, slug: c.slug })));
  r.get('/balance', async ({ app, actor, query }) => app.costs.balances(actor, query.get('project') ? Number(query.get('project')) : null));
  r.post('/settlements', async ({ app, actor, body }) => {
    const b = z.object({ toUserId: z.number().int().positive(), amountMinor: money, currency: z.string().regex(/^[A-Z]{3}$/), method: z.enum(METHODS as [string, ...string[]]), note: z.string().max(300).optional(), projectId: z.number().int().positive().nullable().optional() }).strict().parse(body);
    const { settlement, created } = await app.costs.recordSettlement(actor, { toUserId: b.toUserId, amount: b.amountMinor, currency: b.currency, method: b.method as never, note: b.note ?? null, projectId: b.projectId ?? null });
    return new ApiResponse(created ? 201 : 200, settlement);
  });
  r.post('/settlements/:id/confirm', async (req) => (await req.app.costs.decideSettlement(req.actor, idParam(req), true)).settlement);
  r.post('/settlements/:id/reject', async (req) => (await req.app.costs.decideSettlement(req.actor, idParam(req), false)).settlement);
  r.get('/statements/:month', async (req) => {
    const month = req.params.month ?? '';
    if (month.endsWith('.csv')) {
      const st = await req.app.costs.statement(req.actor, month.slice(0, -4));
      const names = new Map((await req.app.members.list(req.actor.workspaceId)).map((m) => [m.user_id, m.display_name]));
      return new ApiRaw(200, 'text/csv; charset=utf-8', statementCsv(st, names), `tegbar-${month}`);
    }
    return req.app.costs.statement(req.actor, month || localDate(req.app.clock.now()).slice(0, 7));
  });
  r.get('/approvals', async ({ app, actor }) => app.approvals.pending(actor));
  r.post('/approvals/:id/approve', async (req) => (await req.app.approvals.decide(req.actor, idParam(req), true)).approval);
  r.post('/approvals/:id/reject', async (req) => (await req.app.approvals.decide(req.actor, idParam(req), false)).approval);
}
