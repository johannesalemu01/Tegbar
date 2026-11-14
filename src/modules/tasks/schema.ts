import type { Generated, Selectable } from 'kysely';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
export type Priority = 'low' | 'normal' | 'high';
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];
export const OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked'];
export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high'];

export interface TasksTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  area_id: number | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: Priority;
  owner_user_id: number | null;
  created_by: number;
  /** Local calendar date 'YYYY-MM-DD' in the workspace zone (set whenever there is a due date). */
  due_date: string | null;
  /** UTC instant when the task has a due *time*; null for date-only tasks. */
  due_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  deleted_by: number | null;
  created_at: string;
  updated_at: string;
}

export type TaskRow = Selectable<TasksTable>;

declare module '../../core/db/schema.js' {
  interface DB {
    tasks: TasksTable;
  }
}
