import type { DateTime } from 'luxon';
import type { Logger } from 'pino';
import type { Job } from '../db/schema.js';
import type { Jobs } from '../services/jobs.js';
import { fromDb, type Clock } from '../time.js';

/**
 * What a handler wants to do with one due fire. Decided BEFORE any side
 * effect, so the fire can be claimed first (at-most-once delivery).
 */
export interface Plan<D = unknown> {
  action: 'send' | 'skip';
  /** Why we skip (logged in job_fires.detail): 'done', 'quiet', 'focus', ... */
  reason?: string;
  /** When this job fires next; null = finished. */
  next: DateTime | null;
  /** Replace the job payload (e.g. a nudge counter). */
  payload?: unknown;
  /** Data handed to execute(). */
  data?: D;
}

export interface FireContext {
  fireAt: DateTime;
  now: DateTime;
  /** How late we are, in ms (> 0 after downtime). */
  lateMs: number;
}

export interface JobHandler<P = any, D = any> {
  kind: string;
  /** Older than this → the fire is skipped as stale (no catch-up spam after downtime). */
  maxLateMs: number;
  plan(job: Job, payload: P, ctx: FireContext): Promise<Plan<D>>;
  execute(job: Job, payload: P, plan: Plan<D>): Promise<'sent' | 'failed'>;
  /** Next fire time after `now` for recurring jobs (used when a fire is stale); null for one-shots. */
  nextAfter(job: Job, payload: P, now: DateTime): Promise<DateTime | null> | DateTime | null;
}

export interface TickResult {
  sent: number;
  skipped: number;
  stale: number;
  failed: number;
}

/**
 * Polls the jobs table (every 30 s in production). No in-memory timers hold
 * state: everything needed to resume after a restart is in the database.
 */
export class Scheduler {
  private readonly handlers = new Map<string, JobHandler>();
  private running: Promise<TickResult> | null = null;
  private lastPrune = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jobs: Jobs,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly onError: (err: unknown, where: string) => Promise<void>,
  ) {}

  register(h: JobHandler): void {
    if (this.handlers.has(h.kind)) throw new Error(`Job kind ${h.kind} registered twice`);
    this.handlers.set(h.kind, h);
  }

  start(intervalMs = 30_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One pass. Concurrent calls share the same pass. */
  tick(): Promise<TickResult> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<TickResult> {
    const result: TickResult = { sent: 0, skipped: 0, stale: 0, failed: 0 };
    try {
      // Bounded loop: a handler that re-schedules into the past cannot spin forever.
      for (let round = 0; round < 5; round++) {
        const due = await this.jobs.due(this.clock.now());
        if (due.length === 0) break;
        for (const job of due) await this.fire(job, result);
      }
      if (Date.now() - this.lastPrune > 3_600_000) {
        this.lastPrune = Date.now();
        await this.jobs.prune();
      }
    } catch (err) {
      await this.onError(err, 'scheduler.tick');
    }
    if (result.sent || result.failed || result.stale) this.log.info(result, 'scheduler tick');
    return result;
  }

  private async fire(job: Job, result: TickResult): Promise<void> {
    const now = this.clock.now();
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      this.log.warn({ kind: job.kind, key: job.key }, 'no handler for job kind; cancelling');
      await this.jobs.claim(job, { status: 'skipped', detail: 'no handler', next: null, counted: false });
      return;
    }
    const payload: unknown = JSON.parse(job.payload);
    const fireAt = fromDb(job.next_fire_at!);
    const lateMs = now.toMillis() - fireAt.toMillis();

    let plan: Plan;
    let status: 'skipped' | 'stale' | 'claimed';
    try {
      if (lateMs > handler.maxLateMs) {
        plan = { action: 'skip', reason: 'stale', next: await handler.nextAfter(job, payload, now) };
        status = 'stale';
      } else {
        plan = await handler.plan(job, payload, { fireAt, now, lateMs });
        status = plan.action === 'send' ? 'claimed' : 'skipped';
      }
    } catch (err) {
      await this.onError(err, `job.plan:${job.kind}`);
      plan = { action: 'skip', reason: 'plan error', next: await Promise.resolve(handler.nextAfter(job, payload, now)).catch(() => null) };
      status = 'skipped';
    }
    // Never re-schedule into the past.
    if (plan.next && plan.next <= now) plan.next = now.plus({ minutes: 1 });

    const fireId = await this.jobs.claim(job, {
      status, detail: plan.reason, next: plan.next, payload: plan.payload, counted: plan.action === 'send',
    });
    if (fireId === null) return; // already handled or re-planned meanwhile
    if (status === 'stale') return void result.stale++;
    if (plan.action !== 'send') return void result.skipped++;

    try {
      const outcome = await handler.execute(job, payload, plan);
      await this.jobs.finishFire(fireId, outcome);
      if (outcome === 'sent') result.sent++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      await this.jobs.finishFire(fireId, 'failed', err instanceof Error ? err.message.slice(0, 200) : 'error');
      await this.onError(err, `job.execute:${job.kind}`);
    }
  }
}
