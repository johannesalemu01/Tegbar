import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { memberNames, projectOverride } from '../../core/telegram/helpers.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import { show } from '../../core/telegram/render.js';
import { fmtDay } from '../../core/time.js';
import { b, code, esc, i, quote } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { DECISION_NOTIFY, type DecisionStatus, type DecisionView } from './decisions.js';

const STATUS_GLYPH: Record<DecisionStatus, string> = { proposed: '◇', agreed: '◆', superseded: '◈' };
const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

/** "Title — why" or "Title\nwhy". */
export function splitDecision(text: string): { title: string; rationale: string | null } {
  const m = /^(.*?)(?:\s+[—–-]{1,2}\s+|\n)([\s\S]+)$/.exec(text.trim());
  return m ? { title: m[1]!.trim(), rationale: m[2]!.trim() } : { title: text.trim(), rationale: null };
}

function card(d: DecisionView, names: Map<number, string>, me: number, app: App): View {
  const id = enc(d.id);
  const agreed = d.agreed_by.map((u) => names.get(u) ?? '?').join(', ');
  const rows: Btn[][] = [];
  if (d.status === 'proposed' && !d.agreed_by.includes(me)) rows.push([{ text: t('dec.btn_agree'), data: cb('dc', 'ag', id), style: 'success' }]);
  if (d.status !== 'superseded') {
    rows.push([
      { text: t('task.btn_edit'), data: cb('dc', 'ed', id) },
      { text: t('dec.btn_supersede'), data: cb('dc', 'sup', id) },
      { text: t('task.btn_delete'), data: cb('dc', 'del', id) },
    ]);
  }
  rows.push([{ text: G.back, data: cb('dc', 'log', 'a') }]);
  return {
    text: [
      `${STATUS_GLYPH[d.status]} ${b(esc(d.title))}`,
      d.rationale ? quote(esc(d.rationale)) : i(t('dec.no_why')),
      `${b(t(`dec.status.${d.status}`))}${d.decided_on ? ` ${G.dot} ${fmtDay(d.decided_on, app.clock.now())}` : ''} ${G.dot} ${code(d.project_code)} ${G.dot} ${i(`D${d.id}`)}`,
      `${t('dec.agreed_by')} ${esc(agreed) || '—'}`,
      d.meeting_id ? i(t('dec.from_meeting')) : '',
      d.superseded_by ? i(t('dec.superseded_by', { ref: `D${d.superseded_by}` })) : '',
    ].filter(Boolean).join('\n'),
    keyboard: rows,
  };
}

async function logView(ctx: MemberCtx, status: DecisionStatus | null): Promise<View> {
  const { items } = await ctx.app.decisions.list(ctx.actor, { status }, 0, 10);
  const next: Record<string, string> = { a: 'proposed', proposed: 'agreed', agreed: 'superseded', superseded: 'a' };
  const cur = status ?? 'a';
  return {
    text: `◆ ${b(t('dec.log_title'))}${status ? ` ${G.dot} ${i(t(`dec.status.${status}`))}` : ''}\n${RULE}\n${items.map((d, k) => `${b(String(k + 1))}  ${STATUS_GLYPH[d.status]} ${esc(d.title)}\n      ${code(d.project_code)} ${G.dot} ${t(`dec.status.${d.status}`)}${d.decided_on ? ` ${G.dot} ${d.decided_on}` : ''}`).join('\n') || i(t('dec.empty'))}\n\n${i(t('dec.hint'))}`,
    keyboard: [
      ...grid(items.map((d, k) => ({ text: String(k + 1), data: cb('dc', 'o', enc(d.id)) })), 5),
      [{ text: `${t('dec.filter')} ${status ? t(`dec.status.${status}`) : t('task.filter.status.a')} ›`, data: cb('dc', 'log', next[cur]!) }],
      [menuBtn],
    ],
  };
}

export const decisionsModule: TegbarModule = {
  name: 'decisions',
  telegram({ app, reg, notifier }) {
    reg.job(notifyJob(app, notifier));
    reg.command({
      name: 'decide', group: 'other', description: 'cmd.decide',
      handler: async (ctx, args) => {
        const { project, rest } = await projectOverride(ctx.app, ctx.actor, args);
        const { title, rationale } = splitDecision(rest);
        if (!title) throw new DomainError('dec.usage');
        const p = project ?? (await ctx.app.projects.current(ctx.actor));
        const d = await ctx.app.decisions.propose(ctx.actor, { projectId: p.id, title, rationale });
        await show(ctx, card(d, await memberNames(ctx.app, ctx.actor.workspaceId), ctx.actor.userId, ctx.app));
        await ctx.kick();
      },
    });
    reg.command({ name: 'decisions', group: 'other', description: 'cmd.decisions', handler: async (ctx) => show(ctx, await logView(ctx, null)) });

    reg.callback('dc', async (ctx, [action, raw], answer) => {
      const { app, actor } = ctx;
      if (action === 'log') return show(ctx, await logView(ctx, raw === 'a' ? null : (raw as DecisionStatus)));
      const id = dec(raw);
      if (!id) return answer(t('common.stale'), true);
      const names = await memberNames(app, actor.workspaceId);
      switch (action) {
        case 'o': return show(ctx, card(await app.decisions.get(actor, id), names, actor.userId, app));
        case 'ag': {
          const { decision, changed } = await app.decisions.agree(actor, id);
          await answer(changed ? t('dec.agreed_toast') : t('qa.already_handled'));
          await ctx.kick();
          return show(ctx, card(decision, names, actor.userId, app));
        }
        case 'ed': case 'sup':
          await app.pending.set(actor.workspaceId, actor.userId, action === 'ed' ? 'dec.edit' : 'dec.supersede', { id });
          return show(ctx, { text: t(action === 'ed' ? 'dec.edit_prompt' : 'dec.supersede_prompt') }, 'new');
        case 'del': {
          const r = await app.decisions.remove(actor, id);
          await answer(r.applied ? t('task.deleted_toast') : t('cost.split_requested'));
          await ctx.kick();
          return show(ctx, r.applied ? await logView(ctx, null) : { text: t('dec.needs_second_key') });
        }
        default: return answer(t('common.stale'), true);
      }
    });

    reg.input('dec.edit', async (ctx, text, p: { id: number }) => {
      const r = await ctx.app.decisions.edit(ctx.actor, p.id, splitDecision(text));
      await ctx.kick();
      if (!r.applied) return show(ctx, { text: t('dec.needs_second_key') });
      await show(ctx, card(await ctx.app.decisions.get(ctx.actor, p.id), await memberNames(ctx.app, ctx.actor.workspaceId), ctx.actor.userId, ctx.app));
    });
    reg.input('dec.supersede', async (ctx, text, p: { id: number }) => {
      const old = await ctx.app.decisions.get(ctx.actor, p.id);
      const d = await ctx.app.decisions.propose(ctx.actor, { projectId: old.project_id, ...splitDecision(text), supersedes: old.id });
      await show(ctx, card(d, await memberNames(ctx.app, ctx.actor.workspaceId), ctx.actor.userId, ctx.app));
      await ctx.kick();
    });
  },
};

function notifyJob(app: App, notifier: Notifier) {
  return {
    kind: DECISION_NOTIFY, maxLateMs: 7 * 86_400_000, nextAfter: () => null,
    plan: async () => ({ action: 'send' as const, next: null }),
    async execute(job: { workspace_id: number }, p: { decisionId: number; event: 'proposed' | 'agreed'; byUserId?: number }): Promise<'sent' | 'failed'> {
      const row = await app.decisions.byId(job.workspace_id, p.decisionId);
      if (!row || row.deleted_at) return 'sent';
      const names = await memberNames(app, job.workspace_id);
      for (const [userId] of names) {
        const actor = { userId, workspaceId: job.workspace_id };
        if (!(await app.permissions.can(actor, 'project.view', { projectId: row.project_id }))) continue;
        const d = await app.decisions.get(actor, row.id);
        if (p.event === 'proposed' && d.agreed_by.includes(userId)) continue;
        if (p.event === 'agreed' && p.byUserId === userId) continue; // they just saw it on their own card
        const v = card(d, names, userId, app);
        v.text = `${p.event === 'proposed' ? t('dec.new_proposal', { name: names.get(row.created_by) ?? '?' }) : t('dec.now_agreed')}\n\n${v.text}`;
        await notifier.deliver(job.workspace_id, userId, v, 'direct');
      }
      return 'sent';
    },
  };
}
