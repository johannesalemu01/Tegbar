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
  group: 'start' | 'tasks' | 'projects' | 'other';
}

export type Answer = (text?: string, alert?: boolean) => Promise<void>;
export type CallbackHandler = (ctx: MemberCtx, args: string[], answer: Answer) => Promise<void>;
export type InputHandler = (ctx: MemberCtx, text: string, payload: any) => Promise<void>;
/** Returns true if it handled the message. */
export type TextHandler = (ctx: MemberCtx, text: string) => Promise<boolean>;

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
  readonly texts: TextHandler[] = [];
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
  text(handler: TextHandler): void {
    this.texts.push(handler);
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
