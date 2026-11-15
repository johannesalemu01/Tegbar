import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Api } from 'grammy';
import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import type { TegbarModule } from '../../core/module.js';
import type { JobHandler } from '../../core/scheduler/runner.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import { sendTo, show } from '../../core/telegram/render.js';
import { b, esc, i } from '../../core/ui/html.js';
import { cb, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { GoogleError } from './google.js';
import { FLAG_GCAL, GCAL_JOB, S_GOOGLE_EMAIL } from './service.js';

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

async function statusView(ctx: MemberCtx): Promise<View> {
  const { app, actor } = ctx;
  const g = app.gcal;
  const on = await app.flags.isEnabled(actor.workspaceId, FLAG_GCAL);
  const integ = await g.integration(actor.workspaceId);
  const mine = await app.settings.get(actor.workspaceId, S_GOOGLE_EMAIL, actor.userId);
  const lines = [`📅 ${b(t('gcal.title'))}`, RULE];
  const rows: Btn[][] = [];
  if (!g.configured) lines.push(t('gcal.not_configured'));
  else {
    lines.push(on ? t('gcal.feature_on') : t('gcal.feature_off'));
    if (!integ) {
      lines.push(t('gcal.not_connected'));
      rows.push([{ text: t('gcal.btn_connect'), data: cb('gc', 'connect'), style: 'primary' }]);
    } else {
      lines.push(integ.status === 'active' ? t('gcal.connected', { account: integ.account }) : t('gcal.broken', { account: integ.account, reason: integ.last_error ?? '' }));
      if (integ.status !== 'active') rows.push([{ text: t('gcal.btn_reconnect'), data: cb('gc', 'connect'), style: 'primary' }]);
      else rows.push([{ text: t('gcal.btn_sync'), data: cb('gc', 'sync') }]);
      rows.push([{ text: t('gcal.btn_disconnect'), data: cb('gc', 'disc') }]);
    }
    lines.push('', t('gcal.my_email', { email: mine ?? t('common.off') }), i(t('gcal.email_hint')));
  }
  return { text: lines.join('\n'), keyboard: [...rows, [menuBtn]] };
}

function jobs(app: App, notifier: Notifier): JobHandler[] {
  const retry = async (job: { workspace_id: number }, p: { meetingId: number; attempt?: number }, err: unknown) => {
    const attempt = (p.attempt ?? 0) + 1;
    if (err instanceof GoogleError && err.transient && attempt <= 5) {
      await app.gcal.queue(job.workspace_id, p.meetingId, 60 * 2 ** attempt, attempt); // 2, 4, 8, 16, 32 min
      return 'failed' as const;
    }
    if (err instanceof DomainError || (err instanceof GoogleError && err.needsReconnect)) return 'failed' as const; // owner already told
    throw err;
  };
  return [
    {
      kind: GCAL_JOB.sync, maxLateMs: 7 * 86_400_000, nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      async execute(job, p: { meetingId: number; attempt?: number }) {
        try {
          await app.gcal.syncMeeting(job.workspace_id, p.meetingId);
          return 'sent';
        } catch (err) {
          return retry(job, p, err);
        }
      },
    },
    {
      kind: GCAL_JOB.link, maxLateMs: 3_600_000, nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      async execute(job, p: { meetingId: number; attempt: number }) {
        try {
          await app.gcal.checkLink(job.workspace_id, p.meetingId, p.attempt);
          return 'sent';
        } catch (err) {
          return retry(job, { meetingId: p.meetingId, attempt: 99 }, err);
        }
      },
    },
    {
      kind: GCAL_JOB.alert, maxLateMs: 7 * 86_400_000, nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      async execute(job, p: { reason: string }) {
        const integ = await app.gcal.integration(job.workspace_id);
        const to = integ?.created_by ?? (await app.members.bySeat(job.workspace_id, 'A'))?.user_id;
        if (!to) return 'failed';
        await notifier.deliver(job.workspace_id, to, { text: t('gcal.alert', { reason: p.reason }), keyboard: [[{ text: t('gcal.btn_reconnect'), data: cb('gc', 'connect'), style: 'primary' }]] }, 'direct');
        return 'sent';
      },
    },
  ];
}

export const gcalModule: TegbarModule = {
  name: 'gcal',
  telegram({ app, reg, notifier }) {
    for (const h of jobs(app, notifier)) reg.job(h);
    reg.command({
      name: 'google', group: 'other', description: 'cmd.google',
      handler: async (ctx, args) => {
        const m = /^\s*email\s+(\S+|off)\s*$/i.exec(args);
        if (m) {
          const email = m[1]!.toLowerCase() === 'off' ? null : m[1]!;
          try {
            await ctx.app.settings.setAs(ctx.actor, S_GOOGLE_EMAIL, ctx.actor.userId, email);
          } catch {
            throw new DomainError('gcal.bad_email');
          }
          if (await ctx.app.gcal.active(ctx.actor.workspaceId)) await ctx.app.gcal.syncAll(ctx.actor.workspaceId);
          return show(ctx, { text: t('gcal.email_saved', { email: email ?? t('common.off') }) });
        }
        await ctx.app.permissions.authorize(ctx.actor, 'workspace.view');
        await show(ctx, await statusView(ctx));
      },
    });
    reg.callback('gc', async (ctx, [action], answer) => {
      const { app, actor } = ctx;
      if (action === 'connect') {
        const url = await app.gcal.startConnect(actor);
        return show(ctx, { text: t('gcal.connect_hint'), keyboard: [[{ text: t('gcal.btn_open_google'), url }]] }, 'new');
      }
      if (action === 'disc') {
        const { changed } = await app.gcal.disconnect(actor);
        await answer(changed ? t('gcal.disconnected') : t('qa.already_handled'));
        return show(ctx, await statusView(ctx));
      }
      if (action === 'sync') {
        await app.permissions.authorize(actor, 'workspace.manage');
        const n = await app.gcal.syncAll(actor.workspaceId);
        await answer(t('gcal.syncing', { n }));
        await ctx.kick();
        return show(ctx, await statusView(ctx));
      }
      return answer(t('common.stale'), true);
    });
  },
};

/** GET /oauth/google/callback — finishes the connection and tells the owner in Telegram. */
export function createOAuthHandler(app: App, api: () => Api) {
  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tegbar</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h2>${title}</h2><p>${body}</p></body>`;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/oauth/google/callback') return false;
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" };
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, headers).end(page('Not connected', esc(url.searchParams.get('error') ?? 'Google did not return a code.')));
      return true;
    }
    try {
      const r = await app.gcal.finishConnect(state, code);
      const member = await app.members.get(r.workspaceId, r.userId);
      if (member) await sendTo(api(), member.chat_id, { text: t('gcal.connected_msg', { account: r.account }) });
      res.writeHead(200, headers).end(page('✓ Google Calendar connected', `Connected as ${esc(r.account)}. You can close this tab and go back to Telegram.`));
    } catch (err) {
      const msg = err instanceof DomainError ? t(err.key as 'gcal.bad_state').replace(/<[^>]+>/g, '') : 'Something went wrong. Try again from /google in Telegram.';
      if (!(err instanceof DomainError)) app.log.error({ err }, 'google oauth callback failed');
      res.writeHead(400, headers).end(page('Not connected', esc(msg)));
    }
    return true;
  };
}

