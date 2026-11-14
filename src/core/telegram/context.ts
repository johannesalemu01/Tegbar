import type { Context } from 'grammy';
import type { App } from '../../app.js';
import type { Member } from '../db/schema.js';
import type { Actor } from '../services/context.js';

export interface TegbarFlavor {
  app: App;
  actor: Actor | null;
  member: Member | null;
}
export type BotContext = Context & TegbarFlavor;

/** Context after the gate: the sender is a paired, active member. */
export type MemberCtx = BotContext & { actor: Actor; member: Member };
