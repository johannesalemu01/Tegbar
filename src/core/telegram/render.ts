import { GrammyError } from 'grammy';
import type { Api } from 'grammy';
import { keyboard } from '../ui/keyboard.js';
import type { View } from '../ui/view.js';
import type { BotContext } from './context.js';

const opts = (v: View) => ({
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
  ...(v.keyboard ? { reply_markup: keyboard(v.keyboard) } : {}),
});

/**
 * Show a view. Inside a callback query the message is edited in place;
 * otherwise (or if editing is impossible) a new message is sent.
 */
export async function show(ctx: BotContext, view: View, mode: 'auto' | 'new' = 'auto'): Promise<void> {
  if (mode === 'auto' && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(view.text, opts(view));
      return;
    } catch (err) {
      if (err instanceof GrammyError && /message is not modified/i.test(err.description)) return;
      if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
      // e.g. "message can't be edited" — fall through and send a fresh one
    }
  }
  await ctx.reply(view.text, opts(view));
  if (view.venue) await ctx.replyWithVenue(view.venue.latitude, view.venue.longitude, view.venue.title, view.venue.address);
}

/** Send to a chat outside the current update (notifications to the partner). */
export async function sendTo(api: Api, chatId: number, view: View): Promise<boolean> {
  try {
    await api.sendMessage(chatId, view.text, opts(view));
    if (view.venue) await api.sendVenue(chatId, view.venue.latitude, view.venue.longitude, view.venue.title, view.venue.address);
    return true;
  } catch (err) {
    if (err instanceof GrammyError && (err.error_code === 403 || err.error_code === 400)) return false;
    throw err;
  }
}
