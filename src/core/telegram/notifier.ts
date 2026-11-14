import type { Api } from 'grammy';
import { randomUUID } from 'node:crypto';
import type { App } from '../../app.js';
import type { JobHandler } from '../scheduler/runner.js';
import type { Urgency } from '../services/availability.js';
import type { View } from '../ui/view.js';
import { sendTo } from './render.js';

export const DELIVER_KIND = 'notify.deliver';

interface DeliverPayload {
  userId: number;
  view: View;
  urgency: Urgency;
}

/**
 * The one way to message a member outside the current conversation.
 * Respects quiet hours / DND / focus: a held message becomes a
 * `notify.deliver` job at the moment it may be delivered.
 */
export class Notifier {
  constructor(private readonly app: App, private readonly api: () => Api) {}

  /** Returns 'sent', 'deferred' or 'failed' (blocked bot / unknown member). */
  async deliver(workspaceId: number, userId: number, view: View, urgency: Urgency): Promise<'sent' | 'deferred' | 'failed'> {
    const now = this.app.clock.now();
    const until = await this.app.availability.blockedUntil(workspaceId, userId, urgency, now);
    if (until) {
      await this.app.jobs.upsert(workspaceId, `notify:${randomUUID()}`, {
        kind: DELIVER_KIND, userId, payload: { userId, view, urgency } satisfies DeliverPayload, at: until,
      });
      return 'deferred';
    }
    return (await this.sendNow(workspaceId, userId, view)) ? 'sent' : 'failed';
  }

  /** Send immediately (the caller already checked availability). */
  async sendNow(workspaceId: number, userId: number, view: View): Promise<boolean> {
    const member = await this.app.members.get(workspaceId, userId);
    if (!member) return false;
    const ok = await sendTo(this.api(), member.chat_id, view);
    if (!ok) this.app.log.warn({ userId }, 'message not delivered (bot blocked or chat unavailable)');
    return ok;
  }

  /** Scheduler handler for held messages. */
  handler(): JobHandler<DeliverPayload> {
    return {
      kind: DELIVER_KIND,
      maxLateMs: 48 * 3_600_000,
      nextAfter: () => null,
      plan: async (job, p, { now }) => {
        const until = await this.app.availability.blockedUntil(job.workspace_id, p.userId, p.urgency, now);
        return until ? { action: 'skip', reason: 'still held', next: until } : { action: 'send', next: null };
      },
      execute: async (job, p) => ((await this.sendNow(job.workspace_id, p.userId, p.view)) ? 'sent' : 'failed'),
    };
  }
}
