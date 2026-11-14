import { DateTime } from 'luxon';
import type { Db } from '../db/database.js';
import { fromDb, getZone } from '../time.js';
import { defineSetting, isBool, isHHMM, type Settings } from './settings.js';

/**
 * Who may be interrupted, and when.
 *  - urgent: always delivered (urgent notices, Phase 5).
 *  - direct: person-to-person (assignments, one-off reminders, /tell).
 *  - nudge:  automatic nudges (task reminders, overdue nudges, digests).
 * Quiet hours and Do-not-disturb hold back direct + nudge.
 * Focus holds back nudges only. Held messages are delayed, never dropped.
 */
export type Urgency = 'urgent' | 'direct' | 'nudge';

export interface AvailabilityPrefs {
  quietEnabled: boolean;
  quietStart: string; // HH:mm
  quietEnd: string; // HH:mm
  focusUntil: string | null; // UTC ISO
  dndUntil: string | null; // UTC ISO
}

const isNullableIso = (v: unknown): v is string | null => v === null || (typeof v === 'string' && DateTime.fromISO(v).isValid);

export const S_QUIET_ENABLED = defineSetting<boolean>({ key: 'quiet_enabled', scope: 'user', default: true, validate: isBool });
export const S_QUIET_START = defineSetting<string>({ key: 'quiet_start', scope: 'user', default: '22:00', validate: isHHMM });
export const S_QUIET_END = defineSetting<string>({ key: 'quiet_end', scope: 'user', default: '07:00', validate: isHHMM });
export const S_FOCUS_UNTIL = defineSetting<string | null>({ key: 'focus_until', scope: 'user', default: null, validate: isNullableIso });
export const S_DND_UNTIL = defineSetting<string | null>({ key: 'dnd_until', scope: 'user', default: null, validate: isNullableIso });

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export function inQuietHours(p: AvailabilityPrefs, at: DateTime): boolean {
  if (!p.quietEnabled || p.quietStart === p.quietEnd) return false;
  const local = at.setZone(getZone());
  const t = local.hour * 60 + local.minute;
  const s = minutes(p.quietStart);
  const e = minutes(p.quietEnd);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

function quietEndAfter(p: AvailabilityPrefs, at: DateTime): DateTime {
  const local = at.setZone(getZone());
  const [h, m] = p.quietEnd.split(':').map(Number);
  let end = local.set({ hour: h!, minute: m!, second: 0, millisecond: 0 });
  if (end <= local) end = end.plus({ days: 1 });
  return end;
}

/** Null = deliver now. Otherwise the earliest moment the message may be delivered. */
export function blockedUntil(p: AvailabilityPrefs, urgency: Urgency, now: DateTime): DateTime | null {
  if (urgency === 'urgent') return null;
  let t = now;
  for (let i = 0; i < 6; i++) {
    const blocks: DateTime[] = [];
    if (p.dndUntil && fromDb(p.dndUntil) > t) blocks.push(fromDb(p.dndUntil));
    if (urgency === 'nudge' && p.focusUntil && fromDb(p.focusUntil) > t) blocks.push(fromDb(p.focusUntil));
    if (inQuietHours(p, t)) blocks.push(quietEndAfter(p, t));
    if (blocks.length === 0) return t === now ? null : t;
    t = DateTime.max(...blocks)!;
  }
  return t;
}

export class Availability {
  constructor(private readonly db: Db, private readonly settings: Settings) {}

  async prefs(workspaceId: number, userId: number): Promise<AvailabilityPrefs> {
    const g = <T>(d: Parameters<Settings['get']>[1]) => this.settings.get(workspaceId, d, userId) as Promise<T>;
    return {
      quietEnabled: await g<boolean>(S_QUIET_ENABLED),
      quietStart: await g<string>(S_QUIET_START),
      quietEnd: await g<string>(S_QUIET_END),
      focusUntil: await g<string | null>(S_FOCUS_UNTIL),
      dndUntil: await g<string | null>(S_DND_UNTIL),
    };
  }

  async blockedUntil(workspaceId: number, userId: number, urgency: Urgency, now: DateTime): Promise<DateTime | null> {
    return blockedUntil(await this.prefs(workspaceId, userId), urgency, now);
  }
}
