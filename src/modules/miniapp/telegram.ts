import type { Api } from 'grammy';
import type { App } from '../../app.js';
import { t } from '../../core/i18n/index.js';
import type { TegbarModule } from '../../core/module.js';
import { defineFlag, knownFlags } from '../../core/services/flags.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { show } from '../../core/telegram/render.js';
import { b, esc, i } from '../../core/ui/html.js';
import { cb, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';

/** Phase 6 · Mini App dashboard (behind the `miniapp` flag; needs PUBLIC_URL + API_ENABLED). */
export const FLAG_MINIAPP = defineFlag('miniapp', false, 'Mini App dashboard (kanban, calendar, costs) inside Telegram');

let publicUrl: string | null = null;
let apiOn = false;
export function configureMiniApp(opts: { publicUrl?: string | undefined; apiEnabled: boolean }): void {
  publicUrl = opts.publicUrl ? opts.publicUrl.replace(/\/$/, '') : null;
  apiOn = opts.apiEnabled;
}

export function miniAppUrl(): string | null {
  return publicUrl && apiOn ? `${publicUrl}/app/` : null;
}

export async function miniAppEnabled(app: App, workspaceId: number): Promise<boolean> {
  return !!miniAppUrl() && (await app.flags.isEnabled(workspaceId, FLAG_MINIAPP));
}

/** Sets (or resets) the chat menu button ("Dashboard") for every member. */
export async function syncMenuButton(api: Api, app: App, workspaceId: number): Promise<void> {
  const on = await miniAppEnabled(app, workspaceId);
  for (const m of await app.members.list(workspaceId)) {
    await api
      .setChatMenuButton({
        chat_id: m.chat_id,
        menu_button: on ? { type: 'web_app', text: t('mini.menu_button'), web_app: { url: miniAppUrl()! } } : { type: 'commands' },
      })
      .catch((err) => app.log.warn({ err, member: m.id }, 'setChatMenuButton failed'));
  }
}

async function featuresView(ctx: MemberCtx): Promise<View> {
  const rows: Btn[][] = [];
  const lines: string[] = [];
  for (const f of knownFlags()) {
    const on = await ctx.app.flags.isEnabled(ctx.actor.workspaceId, f.key);
    lines.push(`${on ? G.done : G.todo} ${b(esc(f.key))} ${G.dot} ${esc(f.description)}`);
    rows.push([{ text: `${on ? t('features.turn_off') : t('features.turn_on')} ${f.key}`, data: cb('ff', f.key, on ? '0' : '1'), ...(on ? {} : { style: 'primary' as const }) }]);
  }
  const notes = [!miniAppUrl() ? t('mini.needs_setup') : ''].filter(Boolean);
  return {
    text: `🧩 ${b(t('features.title'))}\n${RULE}\n${lines.join('\n') || i(t('features.none'))}\n\n${i(t('features.hint'))}${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
    keyboard: [...rows, [{ text: t('common.menu'), data: cb('m', 'menu') }]],
  };
}

export const miniappModule: TegbarModule = {
  name: 'miniapp',
  telegram({ app, reg }) {
    reg.command({
      name: 'features', group: 'other', description: 'cmd.features',
      handler: async (ctx) => {
        await ctx.app.permissions.authorize(ctx.actor, 'workspace.manage');
        await show(ctx, await featuresView(ctx));
      },
    });
    reg.command({
      name: 'app', group: 'start', description: 'cmd.app',
      handler: async (ctx) => {
        const url = miniAppUrl();
        if (!url || !(await miniAppEnabled(ctx.app, ctx.actor.workspaceId))) return show(ctx, { text: t('mini.off') });
        await show(ctx, { text: t('mini.open_hint'), keyboard: [[{ text: t('mini.btn_open'), webApp: url, style: 'primary' }]] });
      },
    });
    // Button targets carry the desired state (on/off), so a double tap is harmless.
    reg.callback('ff', async (ctx, [key, on], answer) => {
      await ctx.app.permissions.authorize(ctx.actor, 'workspace.manage');
      if (!key || !knownFlags().some((f) => f.key === key) || (on !== '0' && on !== '1')) return answer(t('common.stale'), true);
      await ctx.app.flags.set(ctx.actor.workspaceId, key, on === '1');
      await ctx.app.events.record(ctx.app.db, { workspaceId: ctx.actor.workspaceId, actorUserId: ctx.actor.userId, entityType: 'feature_flag', action: on === '1' ? 'flag.enabled' : 'flag.disabled', data: { key } });
      if (key === FLAG_MINIAPP) await syncMenuButton(ctx.api, ctx.app, ctx.actor.workspaceId);
      await answer(t('common.saved'));
      await show(ctx, await featuresView(ctx));
    });
    reg.menuRows.push(async (ctx) => {
      const url = miniAppUrl();
      return url && (await miniAppEnabled(ctx.app, ctx.actor.workspaceId)) ? [[{ text: t('mini.btn_open'), webApp: url, style: 'primary' }]] : [];
    });
    reg.chatSetup.push((api) => syncMenuButton(api, app, app.workspace.id));
  },
};
