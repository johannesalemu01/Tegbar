import type { Generated, Selectable } from 'kysely';

/** One-off "remind me / remind us" reminders. */
export interface RemindersTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number | null;
  created_by: number;
  text: string;
  remind_at: string; // UTC ISO
  /** JSON array of user ids */
  recipients: string;
  status: 'scheduled' | 'sent' | 'cancelled';
  /** For snoozes: the reminder this one follows up. */
  source_id: number | null;
  created_at: string;
  updated_at: string;
}

export type ReminderRow = Selectable<RemindersTable>;

declare module '../../core/db/schema.js' {
  interface DB {
    reminders: RemindersTable;
  }
}
