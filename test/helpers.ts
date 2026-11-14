import pino from 'pino';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createApp, type App } from '../src/app.js';
import { openDatabase } from '../src/core/db/database.js';
import type { Actor } from '../src/core/services/context.js';
import { createBot } from '../src/core/telegram/bot.js';
import { fixedClock } from '../src/core/time.js';

export const SETUP = 'correct-horse-battery-staple';
export const JOHN = { id: 1001, first_name: 'Yohannes', username: 'john_tg' };
export const SAMI = { id: 1002, first_name: 'Samuel', username: 'sami_tg' };
export const EVE = { id: 6666, first_name: 'Eve' };

export async function makeApp(now = '2026-11-15T10:00:00+03:00') {
  const database = openDatabase(':memory:');
  const clock = fixedClock(now);
  const app = await createApp({
    database, clock, log: pino({ level: 'silent' }), setupCode: SETUP, seatNames: { A: 'John', B: 'Sami' },
  });
  return { app, clock };
}

export async function pairBoth(app: App): Promise<{ john: Actor; sami: Actor }> {
  const a = await app.pairing.tryPair(app.workspace.id, JOHN, JOHN.id, SETUP);
  const b = await app.pairing.tryPair(app.workspace.id, SAMI, SAMI.id, SETUP);
  if (a.kind !== 'paired' || b.kind !== 'paired') throw new Error('pairing failed');
  return {
    john: { userId: a.member.user_id, workspaceId: app.workspace.id },
    sami: { userId: b.member.user_id, workspaceId: app.workspace.id },
  };
}

export async function ridehome(app: App, actor: Actor) {
  const p = await app.projects.findByCode(actor, 'RIDEHOME');
  if (!p) throw new Error('no ridehome');
  return p;
}

// ---------- fake Telegram ----------

export interface ApiCall {
  method: string;
  payload: Record<string, any>;
}

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'Tegbar', username: 'tegbar_test_bot', can_join_groups: false,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

export function makeBot(app: App) {
  const calls: ApiCall[] = [];
  const handle = createBot(app, '0000000:TEST-TOKEN-not-real-xxxxxxxxxxxx', { botInfo: BOT_INFO });
  let messageId = 100;
  handle.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const p = payload as Record<string, any>;
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'editMessageText') {
      result = { message_id: p.message_id ?? ++messageId, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text };
    }
    return { ok: true, result } as any;
  });
  let updateId = 1;
  const send = async (from: { id: number; first_name: string; username?: string }, text: string) => {
    const cmd = /^\/[a-z_]+/.exec(text);
    const update: Update = {
      update_id: updateId++,
      message: {
        message_id: ++messageId, date: 0, chat: { id: from.id, type: 'private', first_name: from.first_name },
        from: { ...from, is_bot: false }, text,
        ...(cmd ? { entities: [{ type: 'bot_command', offset: 0, length: cmd[0].length }] } : {}),
      } as any,
    };
    await handle.bot.handleUpdate(update);
  };
  const tap = async (from: { id: number; first_name: string }, data: string, msgId = 500) => {
    const update: Update = {
      update_id: updateId++,
      callback_query: {
        id: `cq${updateId}`, from: { ...from, is_bot: false }, chat_instance: 'x', data,
        message: { message_id: msgId, date: 0, chat: { id: from.id, type: 'private', first_name: from.first_name }, text: 'old' } as any,
      },
    };
    await handle.bot.handleUpdate(update);
  };
  return { ...handle, calls, send, tap };
}

/** All callback_data values in all keyboards sent so far. */
export function allCallbackData(calls: ApiCall[]): string[] {
  return calls.flatMap((c) =>
    (c.payload.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data).filter(Boolean),
  );
}

export function lastText(calls: ApiCall[]): string {
  const c = [...calls].reverse().find((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c?.payload.text ?? '';
}

export function lastKeyboard(calls: ApiCall[]): any[][] {
  const c = [...calls].reverse().find((x) => x.payload.reply_markup);
  return c?.payload.reply_markup?.inline_keyboard ?? [];
}
