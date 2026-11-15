import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { Member } from '../db/schema.js';
import { toDb, type Clock } from '../time.js';
import type { Hooks } from '../hooks.js';
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

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
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
    private readonly hooks?: Hooks,
  ) {}

  async isClosed(workspaceId: number): Promise<boolean> {
    return this.settings.get(workspaceId, S_REGISTRATION_CLOSED, workspaceId);
  }

  async tryPair(workspaceId: number, profile: TelegramProfile, chatId: number, text: string): Promise<PairResult> {
    const candidate = text.trim().replace(/^\/start(@\w+)?\s*/i, '');
    if (!candidate) return { kind: 'ignored' };
    if (/^TGB-[A-Z2-7]{10}$/i.test(candidate)) return this.redeemInvite(workspaceId, profile, chatId, candidate.toUpperCase());
    if (!sameSecret(candidate, this.opts.setupCode)) return { kind: 'ignored' };

    const result = await this.db.transaction().execute(async (trx): Promise<PairResult> => {
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
    if (result.kind === 'paired') await this.hooks?.emit('member.paired', { workspaceId, userId: result.member.user_id });
    return result;
  }

  // ---------- invites (third person onwards; owner approval required) ----------

  /** Create a not-yet-active invite; it works only after its approval is approved. Returns the plain code once. */
  async createInvite(workspaceId: number, createdBy: number, approvalId: number, displayName: string, role: 'member' | 'viewer'): Promise<string> {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const code = `TGB-${[...randomBytes(10)].map((b) => alphabet[b % 32]).join('')}`;
    const now = this.clock.now();
    await this.db.insertInto('invites').values({
      workspace_id: workspaceId, code_hash: hashCode(code), role, display_name: displayName.trim().slice(0, 40), created_by: createdBy,
      approval_id: approvalId, expires_at: toDb(now.plus({ days: 3 })), used_by: null, used_at: null,
      created_at: toDb(now), updated_at: toDb(now),
    }).execute();
    return code;
  }

  private async redeemInvite(workspaceId: number, profile: TelegramProfile, chatId: number, code: string): Promise<PairResult> {
    const now = toDb(this.clock.now());
    const result = await this.db.transaction().execute(async (trx): Promise<PairResult> => {
      const inv = await trx.selectFrom('invites').selectAll()
        .where('workspace_id', '=', workspaceId).where('code_hash', '=', hashCode(code)).executeTakeFirst();
      if (!inv || inv.used_by !== null || inv.expires_at < now) return { kind: 'ignored' };
      const approval = inv.approval_id
        ? await trx.selectFrom('approvals').select('status').where('id', '=', inv.approval_id).executeTakeFirst()
        : undefined;
      if (approval?.status !== 'approved') return { kind: 'ignored' };
      const existing = await trx.selectFrom('users').selectAll().where('telegram_id', '=', profile.id).executeTakeFirst();
      if (existing && (await trx.selectFrom('workspace_members').select('id').where('workspace_id', '=', workspaceId).where('user_id', '=', existing.id).executeTakeFirst())) {
        return { kind: 'ignored' };
      }
      const userId = existing?.id ?? (await trx.insertInto('users').values({
        telegram_id: profile.id, first_name: profile.first_name, last_name: profile.last_name ?? null, username: profile.username ?? null,
        locale: profile.language_code ?? null, blocked_at: null, created_at: now, updated_at: now,
      }).returning('id').executeTakeFirstOrThrow()).id;
      const taken = new Set((await trx.selectFrom('workspace_members').select('handle').where('workspace_id', '=', workspaceId).execute()).map((m) => m.handle));
      const member = await trx.insertInto('workspace_members').values({
        workspace_id: workspaceId, user_id: userId, role: inv.role, seat: null, display_name: inv.display_name || profile.first_name,
        handle: makeHandle(inv.display_name || profile.first_name, taken), status: 'active', chat_id: chatId, created_at: now, updated_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      // Invited people get the invite's role on every active project.
      for (const p of await trx.selectFrom('projects').select('id').where('workspace_id', '=', workspaceId).where('archived_at', 'is', null).execute()) {
        await trx.insertInto('project_members').values({ workspace_id: workspaceId, project_id: p.id, user_id: userId, role: inv.role, created_at: now, updated_at: now })
          .onConflict((oc) => oc.columns(['project_id', 'user_id']).doNothing()).execute();
      }
      const used = await trx.updateTable('invites').set({ used_by: userId, used_at: now, updated_at: now }).where('id', '=', inv.id).where('used_by', 'is', null).executeTakeFirst();
      if (Number(used.numUpdatedRows) !== 1) throw new Error('invite raced');
      await this.events.record(trx, {
        workspaceId, actorUserId: userId, entityType: 'member', entityId: member.id, action: 'member.invited_joined', data: { inviteId: inv.id, role: inv.role },
      });
      return { kind: 'paired', member, seat: '', complete: true };
    });
    if (result.kind === 'paired') await this.hooks?.emit('member.paired', { workspaceId, userId: result.member.user_id });
    return result;
  }
}
