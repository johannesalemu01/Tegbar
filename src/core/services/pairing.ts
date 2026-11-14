import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { Member } from '../db/schema.js';
import { toDb, type Clock } from '../time.js';
import type { EventLog } from './events.js';
import type { TelegramProfile } from './members.js';
import type { Projects } from './projects.js';
import { S_REGISTRATION_CLOSED, type Settings } from './settings.js';

export const FOUNDER_SEATS = ['A', 'B'] as const;

export type PairResult =
  | { kind: 'paired'; member: Member; seat: string; complete: boolean }
  | { kind: 'already_member'; member: Member }
  | { kind: 'ignored' };

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function makeHandle(name: string, taken: Set<string>): string {
  const base = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 20) || 'member';
  let h = base;
  for (let i = 2; taken.has(h); i++) h = `${base}${i}`;
  return h;
}

/**
 * One-time pairing lock. The first two Telegram users who send SETUP_CODE
 * become seats A and B (both workspace owners). After seat B pairs,
 * registration closes permanently; SETUP_CODE then has no effect.
 * Adding a third person later goes through an owner-approved invite (Phase 4+,
 * built on the generic approvals mechanism) — never through SETUP_CODE.
 */
export class Pairing {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: Settings,
    private readonly projects: Projects,
    private readonly events: EventLog,
    private readonly opts: { setupCode: string; seatNames: Partial<Record<string, string>> },
  ) {}

  async isClosed(workspaceId: number): Promise<boolean> {
    return this.settings.get(workspaceId, S_REGISTRATION_CLOSED, workspaceId);
  }

  async tryPair(workspaceId: number, profile: TelegramProfile, chatId: number, text: string): Promise<PairResult> {
    const candidate = text.trim().replace(/^\/start(@\w+)?\s*/i, '');
    if (!candidate || !sameSecret(candidate, this.opts.setupCode)) return { kind: 'ignored' };

    return this.db.transaction().execute(async (trx) => {
      const existingUser = await trx.selectFrom('users').selectAll().where('telegram_id', '=', profile.id).executeTakeFirst();
      if (existingUser) {
        const m = await trx
          .selectFrom('workspace_members').selectAll()
          .where('workspace_id', '=', workspaceId).where('user_id', '=', existingUser.id).where('status', '=', 'active')
          .executeTakeFirst();
        if (m) return { kind: 'already_member' as const, member: m };
      }
      if (await this.settings.get(workspaceId, S_REGISTRATION_CLOSED, workspaceId, trx)) return { kind: 'ignored' as const };

      const members = await trx
        .selectFrom('workspace_members').select(['seat', 'handle'])
        .where('workspace_id', '=', workspaceId)
        .execute();
      const used = new Set(members.map((m) => m.seat));
      const seat = FOUNDER_SEATS.find((s) => !used.has(s));
      if (!seat) {
        await this.settings.setSystem(workspaceId, S_REGISTRATION_CLOSED, workspaceId, true, trx);
        return { kind: 'ignored' as const };
      }

      const now = toDb(this.clock.now());
      const userId =
        existingUser?.id ??
        (
          await trx
            .insertInto('users')
            .values({
              telegram_id: profile.id, first_name: profile.first_name, last_name: profile.last_name ?? null,
              username: profile.username ?? null, locale: profile.language_code ?? null, blocked_at: null,
              created_at: now, updated_at: now,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      const displayName = this.opts.seatNames[seat]?.trim() || profile.first_name;
      const handle = makeHandle(displayName, new Set(members.map((m) => m.handle)));
      const member = await trx
        .insertInto('workspace_members')
        .values({
          workspace_id: workspaceId, user_id: userId, role: 'owner', seat, display_name: displayName, handle,
          status: 'active', chat_id: chatId, created_at: now, updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.projects.syncOwners(trx, workspaceId);
      const complete = FOUNDER_SEATS.every((s) => s === seat || used.has(s));
      if (complete) {
        await this.settings.setSystem(workspaceId, S_REGISTRATION_CLOSED, workspaceId, true, trx);
        await this.projects.assignDefaultAreaOwners(trx, workspaceId);
      }
      await this.events.record(trx, {
        workspaceId, actorUserId: userId, entityType: 'member', entityId: member.id, action: 'member.paired',
        data: { seat, registrationClosed: complete },
      });
      return { kind: 'paired' as const, member, seat, complete };
    });
  }
}
