import { defineSetting, isHHMM } from '../../core/services/settings.js';

export interface WeeklySlot {
  day: number; // 1 = Mon … 7 = Sun
  time: string; // HH:mm
}
const isWeekly = (v: unknown): v is WeeklySlot | null =>
  v === null ||
  (typeof v === 'object' && v !== null && Number.isInteger((v as WeeklySlot).day) && (v as WeeklySlot).day >= 1 &&
    (v as WeeklySlot).day <= 7 && isHHMM((v as WeeklySlot).time));

export const S_DIGEST_DAILY = defineSetting<string | null>({
  key: 'digest_daily', scope: 'user', default: '08:00', validate: (v): v is string | null => v === null || isHHMM(v),
});
export const S_DIGEST_PLAN = defineSetting<WeeklySlot | null>({
  key: 'digest_plan', scope: 'user', default: { day: 1, time: '08:30' }, validate: isWeekly,
});
export const S_DIGEST_REVIEW = defineSetting<WeeklySlot | null>({
  key: 'digest_review', scope: 'user', default: { day: 5, time: '17:00' }, validate: isWeekly,
});
/** Minutes before a timed due date to remind (the "at due time" reminder is always on). */
export const S_REMIND_BEFORE = defineSetting<number[]>({
  key: 'remind_before', scope: 'user', default: [1440, 60],
  validate: (v): v is number[] => Array.isArray(v) && v.length <= 5 && v.every((x) => Number.isInteger(x) && x > 0 && x <= 10080),
});
export const S_OVERDUE_MAX = defineSetting<number>({
  key: 'overdue_max', scope: 'user', default: 3,
  validate: (v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10,
});
/** When to remind about date-only tasks on their due day. */
export const S_DATEONLY_TIME = defineSetting<string>({ key: 'dateonly_time', scope: 'user', default: '09:00', validate: isHHMM });

export const DIGEST_SETTING_KEYS = new Set([S_DIGEST_DAILY.key, S_DIGEST_PLAN.key, S_DIGEST_REVIEW.key]);
export const TASK_REMINDER_SETTING_KEYS = new Set([S_REMIND_BEFORE.key, S_OVERDUE_MAX.key, S_DATEONLY_TIME.key]);
