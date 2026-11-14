import type { Api } from 'grammy';
import type { Logger } from 'pino';
import { scrub } from '../../logger.js';
import type { Members } from '../services/members.js';
import { esc } from '../ui/html.js';

/**
 * Critical-error alerts to seat A (the technical co-founder). Throttled per
 * error signature so a crash loop cannot flood the chat.
 */
export class Alerter {
  private readonly lastSent = new Map<string, number>();
  constructor(
    private readonly api: () => Api | null,
    private readonly members: Members,
    private readonly workspaceId: number,
    private readonly log: Logger,
    private readonly throttleMs = 10 * 60 * 1000,
  ) {}

  async critical(err: unknown, where: string): Promise<void> {
    const message = scrub(err instanceof Error ? err.message : String(err)).slice(0, 500);
    this.log.error({ err, where }, 'critical error');
    const sig = `${where}:${message.slice(0, 80)}`;
    const now = Date.now();
    if ((this.lastSent.get(sig) ?? 0) + this.throttleMs > now) return;
    this.lastSent.set(sig, now);
    try {
      const api = this.api();
      const a = await this.members.bySeat(this.workspaceId, 'A');
      if (!api || !a) return;
      await api.sendMessage(a.chat_id, `⚠️ <b>Tegbar error</b> in <code>${esc(where)}</code>\n<pre>${esc(message)}</pre>\n<i>Details are in the server logs.</i>`, {
        parse_mode: 'HTML',
      });
    } catch (e) {
      this.log.error({ err: e }, 'failed to send critical alert');
    }
  }
}
