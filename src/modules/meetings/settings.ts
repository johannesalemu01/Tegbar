import { defineSetting, isBool, isHHMM } from '../../core/services/settings.js';

/** Workspace-wide meeting reminder settings. */
export const S_MTG_EVENING = defineSetting<string | null>({
  key: 'meeting_evening_before', scope: 'workspace', default: '20:00',
  validate: (v): v is string | null => v === null || isHHMM(v),
});
/** Minutes before start; 0 = at start. */
export const S_MTG_OFFSETS = defineSetting<number[]>({
  key: 'meeting_offsets', scope: 'workspace', default: [60, 10, 0],
  validate: (v): v is number[] => Array.isArray(v) && v.length <= 6 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 1440),
});
/** Nag the host this many minutes before a virtual meeting that has no link. */
export const S_MTG_LINK_CHECK = defineSetting<number>({
  key: 'meeting_link_check', scope: 'workspace', default: 120,
  validate: (v): v is number => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 2880,
});
export const S_MTG_SEEDED = defineSetting<boolean>({ key: 'meetings_seeded', scope: 'workspace', default: false, validate: isBool });

export const MEETING_HORIZON_WEEKS = 8;
