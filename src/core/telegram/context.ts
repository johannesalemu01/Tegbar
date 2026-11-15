import type { Context } from 'grammy';
import type { App } from '../../app.js';
import type { Member } from '../db/schema.js';
import type { Actor } from '../services/context.js';
import type { Notifier } from './notifier.js';

export interface TegbarFlavor {
  app: App;
  actor: Actor | null;
  member: Member | null;
  notifier: Notifier;
  /** Run the scheduler now (delivers outbox notifications immediately instead of on the next 30 s poll). */
  kick: () => Promise<void>;
  /** Download a file the user sent (null if larger than Telegram's bot download limit). */
  fetchFile: (fileId: string, size: number | null) => Promise<Buffer | null>;
}
export type BotContext = Context & TegbarFlavor;

/** Context after the gate: the sender is a paired, active member. */
export type MemberCtx = BotContext & { actor: Actor; member: Member };
