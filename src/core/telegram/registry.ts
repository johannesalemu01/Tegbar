import type { App } from '../../app.js';
import type { MessageKey } from '../i18n/index.js';
import type { JobHandler } from '../scheduler/runner.js';
import type { Btn } from '../ui/keyboard.js';
import type { BotContext, MemberCtx } from './context.js';
import type { Notifier } from './notifier.js';

export type CommandHandler = (ctx: MemberCtx, args: string) => Promise<void>;
export interface CommandDef {
  name: string;
  description: MessageKey;
  handler: CommandHandler;
  /** Shown in /help under this group. */
  group: 'start' | 'tasks' | 'projects' | 'costs' | 'other';
}

export type Answer = (text?: string, alert?: boolean) => Promise<void>;
export type CallbackHandler = (ctx: MemberCtx, args: string[], answer: Answer) => Promise<void>;
export type InputHandler = (ctx: MemberCtx, text: string, payload: any) => Promise<void>;
/** Returns true if it handled the message. */
export type TextHandler = (ctx: MemberCtx, text: string) => Promise<boolean>;
export interface IncomingFile {
  kind: 'photo' | 'document';
  fileId: string;
  uniqueId: string;
  size: number | null;
  mime: string | null;
  ext: string;
}
export type MediaHandler = (ctx: MemberCtx, file: IncomingFile, payload: any) => Promise<void>;
/** Returns true if it handled a photo/document that arrived without a pending question. */
export type MediaFallback = (ctx: MemberCtx, file: IncomingFile, caption: string) => Promise<boolean>;
export type LocationHandler = (ctx: MemberCtx, loc: { latitude: number; longitude: number }, payload: any) => Promise<void>;
/** Context that a new quick-add draft should be linked to (e.g. the live meeting). */
export type DraftLinker = (ctx: MemberCtx) => Promise<{ type: string; id: number; label: string } | null>;

export interface MenuEntry {
  label: MessageKey;
  command: string;
  order: number;
}
export interface DashboardSection {
  order: number;
  render: (ctx: MemberCtx) => Promise<string | null>;
}

export interface SettingsSection {
  order: number;
  render: (ctx: MemberCtx) => Promise<{ lines: string[]; buttons: Btn[][] }>;
}

export class Registry {
  readonly jobs: JobHandler[] = [];
  readonly settings: SettingsSection[] = [];
  readonly commands = new Map<string, CommandDef>();
  readonly callbacks = new Map<string, CallbackHandler>();
  readonly inputs = new Map<string, InputHandler>();
  readonly texts: { handler: TextHandler; priority: number }[] = [];
  readonly locations = new Map<string, LocationHandler>();
  readonly media = new Map<string, MediaHandler>();
  readonly mediaFallbacks: MediaFallback[] = [];
  readonly draftLinkers: DraftLinker[] = [];
  readonly menu: MenuEntry[] = [];
  readonly dashboard: DashboardSection[] = [];

  command(def: CommandDef): void {
    if (!/^[a-z0-9_]{1,32}$/.test(def.name)) throw new Error(`Bad command name ${def.name}`);
    if (this.commands.has(def.name)) throw new Error(`Command /${def.name} registered twice`);
    this.commands.set(def.name, def);
  }
  callback(prefix: string, handler: CallbackHandler): void {
    if (this.callbacks.has(prefix)) throw new Error(`Callback prefix ${prefix} registered twice`);
    this.callbacks.set(prefix, handler);
  }
  input(kind: string, handler: InputHandler): void {
    if (this.inputs.has(kind)) throw new Error(`Input kind ${kind} registered twice`);
    this.inputs.set(kind, handler);
  }
  /** Lower priority runs first; the tasks module's quick-add fallback uses 100. */
  text(handler: TextHandler, priority = 50): void {
    this.texts.push({ handler, priority });
    this.texts.sort((a, b) => a.priority - b.priority);
  }
  mediaInput(kind: string, handler: MediaHandler): void {
    this.media.set(kind, handler);
  }
  mediaFallback(fn: MediaFallback): void {
    this.mediaFallbacks.push(fn);
  }
  location(kind: string, handler: LocationHandler): void {
    this.locations.set(kind, handler);
  }
  draftLinker(fn: DraftLinker): void {
    this.draftLinkers.push(fn);
  }
  menuEntry(e: MenuEntry): void {
    this.menu.push(e);
    this.menu.sort((a, b) => a.order - b.order);
  }
  job(h: JobHandler): void {
    this.jobs.push(h);
  }
  settingsSection(s: SettingsSection): void {
    this.settings.push(s);
    this.settings.sort((a, b) => a.order - b.order);
  }
  dashboardSection(s: DashboardSection): void {
    this.dashboard.push(s);
    this.dashboard.sort((a, b) => a.order - b.order);
  }
}

export interface TelegramSetup {
  app: App;
  reg: Registry;
  notifier: Notifier;
}

export type { BotContext, MemberCtx };
