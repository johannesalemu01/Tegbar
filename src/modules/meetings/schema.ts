import type { Generated, Selectable } from 'kysely';

export type MeetingMode = 'virtual' | 'in_person';
export type MeetingStatus = 'scheduled' | 'skipped' | 'live' | 'done' | 'cancelled';

/** A recurring weekly slot. Per-meeting changes never modify this row. */
export interface MeetingSeriesTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  title: string;
  weekday: number; // 1 = Mon … 7 = Sun
  time: string; // HH:mm local
  duration_min: number;
  mode: MeetingMode;
  place_id: number | null;
  /** Reusable Meet room attached to every virtual meeting of this slot. */
  room_url: string | null;
  /** Offset for the alternating host rotation. */
  ordinal: number;
  active: number;
  created_at: string;
  updated_at: string;
}

/**
 * One meeting. For slot meetings, NULL in an override column means "use the
 * slot's value" (resolved at read time), so slot edits never clobber
 * per-meeting overrides and overrides never alter the slot.
 */
export interface MeetingsTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  series_id: number | null;
  /** Monday of the slot's week — the occurrence key (unique with series_id). Null for extra meetings. */
  week_start: string | null;
  title: string | null;
  start_at: string; // UTC, materialised for queries and jobs
  moved: number;
  duration_min: number | null;
  mode: MeetingMode | null;
  host_user_id: number | null;
  place_id: number | null;
  meet_url: string | null;
  status: MeetingStatus;
  started_at: string | null;
  ended_at: string | null;
  /** iCalendar SEQUENCE; bumped on every change. */
  sequence: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** Audit of per-meeting overrides (skip, move, mode, host, place, link, length). */
export interface MeetingExceptionsTable {
  id: Generated<number>;
  workspace_id: number;
  meeting_id: number;
  field: string;
  data: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlacesTable {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  address: string | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  is_default: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RsvpStatus = 'going' | 'late' | 'no';
export interface RsvpsTable {
  id: Generated<number>;
  workspace_id: number;
  meeting_id: number;
  user_id: number;
  status: RsvpStatus;
  late_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export interface AgendaItemsTable {
  id: Generated<number>;
  workspace_id: number;
  meeting_id: number;
  source: 'auto' | 'manual' | 'carry';
  ref_type: string | null;
  ref_id: number | null;
  text: string;
  position: number;
  status: 'open' | 'done' | 'dropped';
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type OutcomeKind = 'task' | 'decision' | 'question' | 'note';
export interface MeetingOutcomesTable {
  id: Generated<number>;
  workspace_id: number;
  meeting_id: number;
  kind: OutcomeKind;
  text: string;
  task_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface MeetingProposalsTable {
  id: Generated<number>;
  workspace_id: number;
  meeting_id: number;
  proposed_by: number;
  kind: 'move' | 'skip';
  start_at: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'superseded';
  decided_by: number | null;
  created_at: string;
  updated_at: string;
}

export type SeriesRow = Selectable<MeetingSeriesTable>;
export type MeetingRow = Selectable<MeetingsTable>;
export type PlaceRow = Selectable<PlacesTable>;
export type RsvpRow = Selectable<RsvpsTable>;
export type AgendaRow = Selectable<AgendaItemsTable>;
export type OutcomeRow = Selectable<MeetingOutcomesTable>;
export type ProposalRow = Selectable<MeetingProposalsTable>;

declare module '../../core/db/schema.js' {
  interface DB {
    meeting_series: MeetingSeriesTable;
    meetings: MeetingsTable;
    meeting_exceptions: MeetingExceptionsTable;
    places: PlacesTable;
    rsvps: RsvpsTable;
    agenda_items: AgendaItemsTable;
    meeting_outcomes: MeetingOutcomesTable;
    meeting_proposals: MeetingProposalsTable;
  }
}
