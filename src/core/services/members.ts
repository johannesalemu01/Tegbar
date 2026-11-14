import type { Db, DbOrTx } from '../db/database.js';
import type { Member, User } from '../db/schema.js';
import { toDb, type Clock } from '../time.js';

export interface TelegramProfile {
  id: number;
  first_name: string;
  last_name?: string | undefined;
  username?: string | undefined;
  language_code?: string | undefined;
}

export class Members {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** Active membership for a Telegram user, or null (=> outsider, ignore). */
  async findByTelegramId(telegramId: number): Promise<{ user: User; member: Member } | null> {
    const user = await this.db.selectFrom('users').selectAll().where('telegram_id', '=', telegramId).executeTakeFirst();
    if (!user) return null;
    const member = await this.db
      .selectFrom('workspace_members')
      .selectAll()
      .where('user_id', '=', user.id)
      .where('status', '=', 'active')
      .orderBy('id')
      .executeTakeFirst();
    return member ? { user, member } : null;
  }

  async list(workspaceId: number, exec: DbOrTx = this.db): Promise<Member[]> {
    return exec
      .selectFrom('workspace_members')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'active')
      .orderBy('seat')
      .orderBy('id')
      .execute();
  }

  async get(workspaceId: number, userId: number, exec: DbOrTx = this.db): Promise<Member | undefined> {
    return exec
      .selectFrom('workspace_members')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  async bySeat(workspaceId: number, seat: string): Promise<Member | undefined> {
    return this.db
      .selectFrom('workspace_members')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('seat', '=', seat)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  /** Keep Telegram profile fields fresh; clears blocked_at since the user is talking to us. */
  async touch(user: User, p: TelegramProfile): Promise<void> {
    const changed =
      user.first_name !== p.first_name ||
      user.last_name !== (p.last_name ?? null) ||
      user.username !== (p.username ?? null) ||
      user.blocked_at !== null;
    if (!changed) return;
    await this.db
      .updateTable('users')
      .set({
        first_name: p.first_name, last_name: p.last_name ?? null, username: p.username ?? null,
        blocked_at: null, updated_at: toDb(this.clock.now()),
      })
      .where('id', '=', user.id)
      .execute();
  }

  async markBlockedByChat(chatId: number): Promise<void> {
    const now = toDb(this.clock.now());
    await this.db
      .updateTable('users')
      .set({ blocked_at: now, updated_at: now })
      .where('telegram_id', '=', chatId)
      .where('blocked_at', 'is', null)
      .execute();
  }
}
