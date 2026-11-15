import { Bot, GrammyError, HttpError, type Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { MODULES, type App } from '../../app.js';
import { DomainError } from '../errors.js';
import { t } from '../i18n/index.js';
import type { Member } from '../db/schema.js';
import { Alerter } from './alerts.js';
import type { BotContext, MemberCtx } from './context.js';
import { installApiGuard } from './guard.js';
import { sendTo, show } from './render.js';
import { Registry, type Answer } from './registry.js';
import { Notifier } from './notifier.js';
import { Scheduler } from '../scheduler/runner.js';

export interface BotHandle {
  bot: Bot<BotContext>;
  reg: Registry;
  alerter: Alerter;
  notifier: Notifier;
  scheduler: Scheduler;
  syncCommands(): Promise<void>;
}

/** Telegram's Bot API serves files up to 20 MB to bots (getFile). */
export const MAX_BOT_DOWNLOAD = 20 * 1024 * 1024;

export function createBot(
  app: App,
  token: string,
  opts: { botInfo?: UserFromGetMe; onUpdate?: () => void; downloadFile?: (fileId: string) => Promise<Buffer> } = {},
): BotHandle {
  const bot = new Bot<BotContext>(token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  installApiGuard(bot.api, app.log, (chatId) => app.members.markBlockedByChat(chatId));
  const alerter = new Alerter(() => bot.api, app.members, app.workspace.id, app.log);

  const notifier = new Notifier(app, () => bot.api);
  const reg = new Registry();
  for (const m of MODULES) m.telegram?.({ app, reg, notifier });

  const scheduler = new Scheduler(app.jobs, app.clock, app.log, (err, where) => alerter.critical(err, where));
  scheduler.register(notifier.handler());
  for (const h of reg.jobs) scheduler.register(h);

  /** Run a member handler, turning DomainErrors into friendly replies. */
  async function guarded(ctx: MemberCtx, where: string, fn: () => Promise<void>, answer?: Answer): Promise<void> {
    const cbAnswer: Answer =
      answer ?? ((text, alert) => ctx.answerCallbackQuery({ text: text && stripHtml(text), show_alert: alert }).then(() => undefined));
    try {
      await fn();
    } catch (err) {
      if (err instanceof DomainError) {
        const msg = t(err.key, ...(err.params as []));
        if (ctx.callbackQuery) await cbAnswer(msg, true).catch(() => undefined);
        else await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }
      await alerter.critical(err, where);
      if (ctx.callbackQuery) await cbAnswer(t('common.error'), true).catch(() => undefined);
      else await ctx.reply(t('common.error'), { parse_mode: 'HTML' }).catch(() => undefined);
    }
  }

  // 1. Attach app.
  bot.use(async (ctx, next) => {
    opts.onUpdate?.();
    ctx.app = app;
    ctx.notifier = notifier;
    ctx.kick = async () => {
      await scheduler.tick();
    };
    ctx.fetchFile = async (fileId, size) => {
      if (size !== null && size > MAX_BOT_DOWNLOAD) return null;
      if (opts.downloadFile) return opts.downloadFile(fileId);
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) return null;
      // The URL contains the token: never log it.
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };
    ctx.actor = null;
    ctx.member = null;
    await next();
  });

  // 2. Gate: private chats only; members pass, outsiders can only pair.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    const found = await app.members.findByTelegramId(ctx.from.id);
    if (found) {
      ctx.actor = { userId: found.user.id, workspaceId: found.member.workspace_id };
      ctx.member = found.member;
      await app.members.touch(found.user, ctx.from);
      return next();
    }
    const text = ctx.message?.text;
    if (!text) return; // silently ignore outsiders
    const res = await app.pairing.tryPair(app.workspace.id, ctx.from, ctx.chat.id, text);
    if (res.kind !== 'paired') {
      app.log.info({ from: ctx.from.id }, 'ignored message from non-member');
      return;
    }
    app.log.info({ seat: res.seat, complete: res.complete }, 'member paired');
    await ctx.deleteMessage().catch(() => undefined); // remove the setup code from chat history
    await onPaired(ctx, res.member, res.complete);
  });

  async function onPaired(ctx: BotContext, member: Member, complete: boolean): Promise<void> {
    await ctx.reply(t('pair.welcome', { name: member.display_name, seat: member.seat ?? '', complete }), { parse_mode: 'HTML' });
    const others = (await app.members.list(app.workspace.id)).filter((m) => m.id !== member.id);
    for (const o of others) {
      const ok = await sendTo(bot.api, o.chat_id, { text: t('pair.partner_joined', { name: member.display_name }) });
      if (!ok) app.log.warn({ to: o.user_id }, 'could not notify partner about pairing');
    }
    await syncCommands();
  }

  // 3. Commands (a command always cancels any pending text question).
  for (const def of reg.commands.values()) {
    bot.command(def.name, async (ctx) => {
      const m = ctx as MemberCtx;
      await app.pending.clear(m.actor.workspaceId, m.actor.userId);
      await guarded(m, `/${def.name}`, () => def.handler(m, String(ctx.match ?? '').trim()));
    });
  }

  // 4. Callback buttons — always answered exactly once.
  bot.on('callback_query:data', async (ctx) => {
    const m = ctx as MemberCtx;
    let answered = false;
    const answer = async (text?: string, alert = false) => {
      if (answered) return;
      answered = true;
      await ctx.answerCallbackQuery(text ? { text: stripHtml(text), show_alert: alert } : {}).catch(() => undefined);
    };
    const [prefix = '', ...args] = ctx.callbackQuery.data.split(':');
    // Tapping any button abandons an unanswered text question (handlers may set a new one).
    await app.pending.clear(m.actor.workspaceId, m.actor.userId);
    const handler = reg.callbacks.get(prefix);
    await guarded(m, `cb:${prefix}:${args[0] ?? ''}`, async () => {
      if (!handler) await answer(t('common.stale'), true);
      else await handler(m, args, answer);
    }, answer);
    await answer();
  });

  // 5. Text: pending question → module text handlers → help.
  bot.on('message:text', async (ctx) => {
    const m = ctx as MemberCtx;
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await ctx.reply(t('common.unknown_command'), { parse_mode: 'HTML' });
      return;
    }
    await guarded(m, 'text', async () => {
      const pending = await app.pending.take<unknown>(m.actor.workspaceId, m.actor.userId);
      if (pending) {
        const h = reg.inputs.get(pending.kind);
        if (h) return h(m, text, pending.payload);
      }
      for (const h of reg.texts) if (await h.handler(m, text)) return;
      await show(m, { text: t('common.text_unhandled') });
    });
  });

  const onFile = async (ctx: BotContext, file: import('./registry.js').IncomingFile, caption: string) => {
    const m = ctx as MemberCtx;
    await guarded(m, 'file', async () => {
      const pending = await app.pending.take<unknown>(m.actor.workspaceId, m.actor.userId);
      const h = pending ? reg.media.get(pending.kind) : undefined;
      if (h) return h(m, file, pending!.payload);
      if (pending) await app.pending.set(m.actor.workspaceId, m.actor.userId, pending.kind, pending.payload);
      for (const f of reg.mediaFallbacks) if (await f(m, file, caption)) return;
      await ctx.reply(t('common.file_hint'), { parse_mode: 'HTML' });
    });
  };
  bot.on('message:photo', async (ctx) => {
    const p = ctx.message.photo.at(-1)!; // largest size
    await onFile(ctx, { kind: 'photo', fileId: p.file_id, uniqueId: p.file_unique_id, size: p.file_size ?? null, mime: 'image/jpeg', ext: '.jpg' }, ctx.message.caption ?? '');
  });
  bot.on('message:document', async (ctx) => {
    const d = ctx.message.document;
    const ext = /\.[a-z0-9]{1,5}$/i.exec(d.file_name ?? '')?.[0] ?? '.bin';
    await onFile(ctx, { kind: 'document', fileId: d.file_id, uniqueId: d.file_unique_id, size: d.file_size ?? null, mime: d.mime_type ?? null, ext }, ctx.message.caption ?? '');
  });

  bot.on('message:location', async (ctx) => {
    const m = ctx as MemberCtx;
    await guarded(m, 'location', async () => {
      const pending = await app.pending.take<unknown>(m.actor.workspaceId, m.actor.userId);
      const h = pending ? reg.locations.get(pending.kind) : undefined;
      if (!h) {
        if (pending) await app.pending.set(m.actor.workspaceId, m.actor.userId, pending.kind, pending.payload);
        await ctx.reply(t('common.text_only'), { parse_mode: 'HTML' });
        return;
      }
      const { latitude, longitude } = ctx.message.location;
      await h(m, { latitude, longitude }, pending!.payload);
    });
  });

  bot.on('message', async (ctx) => {
    await ctx.reply(t('common.text_only'), { parse_mode: 'HTML' });
  });

  bot.catch(async (err) => {
    const e = err.error;
    if (e instanceof GrammyError) app.log.error({ method: e.method, code: e.error_code, desc: e.description }, 'telegram api error');
    else if (e instanceof HttpError) app.log.error({ err: e }, 'telegram network error');
    await alerter.critical(e, `update ${err.ctx.update.update_id}`);
  });

  async function syncCommands(): Promise<void> {
    await syncCommandsFor(bot.api, app, reg);
  }

  return { bot, reg, alerter, notifier, scheduler, syncCommands };
}

/**
 * Command menus are set per member chat, so outsiders see no commands at all.
 * Telegram command names: 1-32 chars of a-z, 0-9, _ ; descriptions 1-256 chars.
 */
export async function syncCommandsFor(api: Api, app: App, reg: Registry): Promise<void> {
  for (const fn of reg.chatSetup) await fn(api).catch((err) => app.log.warn({ err }, 'chat setup failed'));
  const commands = [...reg.commands.values()].map((c) => ({ command: c.name, description: t(c.description) }));
  await api.deleteMyCommands().catch(() => undefined);
  for (const m of await app.members.list(app.workspace.id)) {
    await api
      .setMyCommands(commands, { scope: { type: 'chat', chat_id: m.chat_id } })
      .catch((err) => app.log.warn({ err, member: m.id }, 'setMyCommands failed'));
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 200);
}
