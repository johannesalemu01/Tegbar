import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { memberNames, projectOverride } from '../../core/telegram/helpers.js';
import { show } from '../../core/telegram/render.js';
import { b, code, esc, i } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

async function listView(ctx: MemberCtx, projectId: number): Promise<View> {
  const p = await ctx.app.projects.get(ctx.actor, projectId);
  const areas = await ctx.app.projects.areas(ctx.actor, projectId);
  const names = await memberNames(ctx.app, ctx.actor.workspaceId);
  const projects = await ctx.app.projects.list(ctx.actor);
  const nextP = projects[(projects.findIndex((x) => x.id === projectId) + 1) % projects.length]!;
  return {
    text: `${G.area} ${b(t('area.title'))} ${code(p.code)}\n${RULE}\n${areas.map((a, k) => `${b(String(k + 1))}  ${esc(a.name)} ${G.dot} ${esc(names.get(a.owner_user_id ?? 0) ?? t('project.unowned'))}${a.backup_user_id ? ` ${i(`· ${t('project.backup')} ${esc(names.get(a.backup_user_id) ?? '?')}`)}` : ''}`).join('\n') || i(t('area.empty'))}\n\n${i(t('area.hint'))}`,
    keyboard: [
      ...grid(areas.map((a, k) => ({ text: String(k + 1), data: cb('ar', 'o', enc(a.id)) })), 6),
      [{ text: t('area.btn_add'), data: cb('ar', 'add', enc(projectId)) }, { text: `${G.project} ${nextP.code} ›`, data: cb('ar', 'l', enc(nextP.id)) }],
      [menuBtn],
    ],
  };
}

async function cardView(ctx: MemberCtx, areaId: number): Promise<View> {
  const a = await ctx.app.projects.area(ctx.actor, areaId);
  const names = await memberNames(ctx.app, ctx.actor.workspaceId);
  const id = enc(a.id);
  return {
    text: `${G.area} ${b(esc(a.name))}\n${t('area.owner')} ${esc(names.get(a.owner_user_id ?? 0) ?? t('project.unowned'))}\n${t('area.backup')} ${esc(names.get(a.backup_user_id ?? 0) ?? '—')}\n\n${i(t('area.owner_rule'))}`,
    keyboard: [
      [...names].map(([u, n]) => ({ text: `${a.owner_user_id === u ? `${G.done} ` : ''}${t('area.btn_owner', { name: n })}`, data: cb('ar', 'own', id, enc(u)) })),
      [...names].map(([u, n]) => ({ text: `${a.backup_user_id === u ? `${G.done} ` : ''}${t('area.btn_backup', { name: n })}`, data: cb('ar', 'bk', id, enc(u)) })),
      [{ text: t('project.btn_rename'), data: cb('ar', 'ren', id) }, { text: t('project.btn_archive'), data: cb('ar', 'arc', id) }],
      [{ text: G.back, data: cb('ar', 'l', enc(a.project_id)) }],
    ],
  };
}

export const areasModule: TegbarModule = {
  name: 'areas',
  telegram({ reg }) {
    reg.command({
      name: 'areas', group: 'projects', description: 'cmd.areas',
      handler: async (ctx, args) => {
        const { project } = await projectOverride(ctx.app, ctx.actor, args);
        await show(ctx, await listView(ctx, (project ?? (await ctx.app.projects.current(ctx.actor))).id));
      },
    });
    reg.callback('ar', async (ctx, [action, raw, target], answer) => {
      const { app, actor } = ctx;
      const id = dec(raw);
      if (!id) return answer(t('common.stale'), true);
      switch (action) {
        case 'l': return show(ctx, await listView(ctx, id));
        case 'o': return show(ctx, await cardView(ctx, id));
        case 'own': {
          const uid = dec(target);
          if (!uid) return answer(t('common.stale'), true);
          const a = await app.projects.area(actor, id);
          if (a.owner_user_id === uid) return answer(t('common.nothing_changed'));
          const names = await memberNames(app, actor.workspaceId);
          const p = await app.projects.get(actor, a.project_id);
          // Two-key rule: owner changes wait for another member's approval.
          await app.approvals.request(actor, 'areas.owner', { areaId: id, ownerUserId: uid, label: `${p.code} · ${a.name} → ${names.get(uid) ?? '?'}` }, a.project_id);
          await answer(t('cost.split_requested'));
          await ctx.kick();
          return show(ctx, { text: t('area.owner_requested', { area: a.name, name: names.get(uid) ?? '?' }) });
        }
        case 'bk': {
          const uid = dec(target);
          if (!uid) return answer(t('common.stale'), true);
          await app.projects.updateArea(actor, id, { backupUserId: uid });
          return show(ctx, await cardView(ctx, id));
        }
        case 'arc': {
          const a = await app.projects.updateArea(actor, id, { archived: true });
          return show(ctx, await listView(ctx, a.project_id));
        }
        case 'ren': case 'add':
          await app.pending.set(actor.workspaceId, actor.userId, action === 'ren' ? 'area.rename' : 'area.add', { id });
          return show(ctx, { text: t('area.name_prompt') }, 'new');
        default: return answer(t('common.stale'), true);
      }
    });
    reg.input('area.rename', async (ctx, text, p: { id: number }) => {
      await ctx.app.projects.updateArea(ctx.actor, p.id, { name: text });
      await show(ctx, await cardView(ctx, p.id), 'new');
    });
    reg.input('area.add', async (ctx, text, p: { id: number }) => {
      if (!text.trim()) throw new DomainError('area.bad_name');
      await ctx.app.projects.addArea(ctx.actor, p.id, text);
      await show(ctx, await listView(ctx, p.id), 'new');
    });
  },
};
