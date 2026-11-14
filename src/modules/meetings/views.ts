import type { DateTime } from 'luxon';
import { t } from '../../core/i18n/index.js';
import { enc } from '../../core/ids.js';
import { fmtDay, fmtTime, fromDb, localDate, type TimeFormat } from '../../core/time.js';
import { b, clip, code, esc, i } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE, STATUS_GLYPH } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import type { AgendaRow, PlaceRow, ProposalRow, SeriesRow } from './schema.js';
import { shortMeet } from './schedule.js';
import { DURATIONS, type AgendaItemView, type MeetingSummary, type MeetingView } from './service.js';

export interface MLookup {
  now: DateTime;
  fmt: TimeFormat;
  meUserId: number;
  names: Map<number, string>;
  attendees: number[];
}

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MODE_GLYPH = { virtual: '💻', in_person: '📍' } as const;
const back = (data: string): Btn => ({ text: G.back, data });
const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

export function when(m: MeetingView, l: MLookup): string {
  return `${fmtDay(localDate(m.start), l.now)} ${G.dot} ${fmtTime(m.start, l.fmt)}–${fmtTime(m.end, l.fmt)}`;
}

function placeText(p: PlaceRow | null): string {
  if (!p) return i(t('mtg.no_place'));
  return `${b(esc(p.name))}${p.address ? ` — ${esc(p.address)}` : ''}${p.notes ? `\n   ${i(esc(p.notes))}` : ''}`;
}

export function whereLines(m: MeetingView, l: MLookup): string[] {
  const host = m.hostName ? t('mtg.host', { name: m.hostName }) : t('mtg.no_host');
  if (m.mode === 'virtual') {
    const link = m.link
      ? `🔗 ${esc(shortMeet(m.link))}${m.linkFromRoom ? ` ${i(t('mtg.room'))}` : ''}`
      : `${G.warn} ${b(t('mtg.no_link'))} ${i(t('mtg.host_adds', { name: m.hostName ?? '—' }))}`;
    return [`${MODE_GLYPH.virtual} ${t('mtg.virtual')} ${G.dot} ${esc(host)}`, link];
  }
  return [`${MODE_GLYPH.in_person} ${t('mtg.in_person')} ${G.dot} ${esc(host)}`, `   ${placeText(m.place)}`];
}

export function rsvpLine(m: MeetingView, l: MLookup): string {
  const parts = l.attendees.map((uid) => {
    const r = m.rsvps.find((x) => x.user_id === uid);
    const name = esc(l.names.get(uid) ?? '?');
    if (!r) return `${name} ○`;
    if (r.status === 'going') return `${name} ✓`;
    if (r.status === 'late') return `${name} ⏱ +${r.late_minutes}`;
    return `${name} ✕`;
  });
  return `${t('mtg.rsvp')}  ${parts.join(`  ${G.dot}  `)}`;
}

const statusTag = (m: MeetingView) =>
  m.status === 'skipped' ? ` ${i(t('mtg.status.skipped'))}`
  : m.status === 'live' ? ` ${b(t('mtg.status.live'))}`
  : m.status === 'done' ? ` ${i(t('mtg.status.done'))}`
  : m.status === 'cancelled' ? ` ${i(t('mtg.status.cancelled'))}`
  : m.moved ? ` ${i(t('mtg.moved'))}` : '';

export function rsvpButtons(m: MeetingView, l: MLookup): Btn[] {
  const id = enc(m.id);
  const mine = m.rsvps.find((r) => r.user_id === l.meUserId);
  const sel = (on: boolean): { style?: 'primary' } => (on ? { style: 'primary' } : {});
  return [
    { text: t('mtg.btn_going'), data: cb('mt', 'r', id, 'g'), ...sel(mine?.status === 'going') },
    { text: '⏱ +10', data: cb('mt', 'r', id, 'l10'), ...sel(mine?.status === 'late' && mine.late_minutes === 10) },
    { text: '⏱ +20', data: cb('mt', 'r', id, 'l20'), ...sel(mine?.status === 'late' && mine.late_minutes === 20) },
    { text: t('mtg.btn_cant'), data: cb('mt', 'r', id, 'n'), ...sel(mine?.status === 'no') },
  ];
}

export function joinButton(m: MeetingView): Btn[] {
  return m.mode === 'virtual' && m.link ? [{ text: t('mtg.btn_join'), url: m.link, style: 'success' }] : [];
}

// ---------- list / card ----------

export function listView(items: MeetingView[], l: MLookup): View {
  const lines = items.map((m, idx) =>
    `${b(String(idx + 1))}  ${MODE_GLYPH[m.mode]} ${b(esc(m.title))}${statusTag(m)}\n      ${when(m, l)}${m.hostName ? ` ${G.dot} ${esc(m.hostName)}` : ''}${m.mode === 'in_person' && m.place ? ` ${G.dot} ${esc(m.place.name)}` : ''}`,
  );
  return {
    text: `◉ ${b(t('mtg.list_title'))}\n${RULE}\n${lines.join('\n') || i(t('mtg.none'))}`,
    keyboard: [
      ...grid(items.map((m, idx) => ({ text: String(idx + 1), data: cb('mt', 'o', enc(m.id)) })), 6),
      [{ text: t('mtg.btn_extra'), data: cb('mt', 'x', '0') }, { text: t('mtg.btn_history'), data: cb('mt', 'h', '0') }],
      [{ text: t('mtg.btn_slots'), data: cb('mt', 's', '0') }, { text: t('mtg.btn_places'), data: cb('mt', 'pl', '0') }, { text: t('mtg.btn_ics_all'), data: cb('mt', 'icsall', '0') }],
      [menuBtn],
    ],
  };
}

export function cardView(m: MeetingView, l: MLookup, extra: { agendaCount: number; outcomes: number }, banner?: string): View {
  const id = enc(m.id);
  const text = [
    banner ? `${i(esc(banner))}\n` : '',
    `◉ ${b(esc(m.title))}${statusTag(m)}`,
    when(m, l),
    ...whereLines(m, l),
    '',
    rsvpLine(m, l),
    `📋 ${t('mtg.agenda_count', { n: extra.agendaCount })}${extra.outcomes ? ` ${G.dot} ${t('mtg.outcome_count', { n: extra.outcomes })}` : ''}`,
  ].join('\n').replace(/^\n+/, '');

  const rows: Btn[][] = [];
  if (m.status === 'scheduled' || m.status === 'live') {
    rows.push(joinButton(m));
    if (m.status === 'scheduled') rows.push(rsvpButtons(m, l));
    rows.push([
      { text: t('mtg.btn_agenda'), data: cb('mt', 'ag', id) },
      { text: t('mtg.btn_calendar'), data: cb('mt', 'ics', id) },
      { text: t('mtg.btn_change'), data: cb('mt', 'c', id) },
    ]);
    if (m.status === 'live') {
      rows.push([
        { text: t('mtg.btn_action'), data: cb('mt', 'out', id, 'task') },
        { text: t('mtg.btn_decision'), data: cb('mt', 'out', id, 'decision') },
      ]);
      rows.push([
        { text: t('mtg.btn_question'), data: cb('mt', 'out', id, 'question') },
        { text: t('mtg.btn_note'), data: cb('mt', 'out', id, 'note') },
      ]);
      rows.push([{ text: t('mtg.btn_end'), data: cb('mt', 'end', id), style: 'danger' }]);
    } else {
      rows.push([{ text: t('mtg.btn_start'), data: cb('mt', 'go', id), style: 'primary' }]);
    }
  } else if (m.status === 'skipped') {
    rows.push([{ text: t('mtg.btn_unskip'), data: cb('mt', 'unskip', id), style: 'primary' }]);
  } else if (m.status === 'done') {
    rows.push([{ text: t('mtg.btn_summary'), data: cb('mt', 'sum', id), style: 'primary' }]);
  }
  rows.push([back(cb('mt', 'l', '0'))]);
  return { text, keyboard: rows };
}

export function changeView(m: MeetingView, l: MLookup): View {
  const id = enc(m.id);
  const other = m.mode === 'virtual' ? 'in_person' : 'virtual';
  return {
    text: `${b(t('mtg.change_title'))}\n${esc(m.title)} ${G.dot} ${when(m, l)}\n\n${i(t('mtg.change_hint'))}`,
    keyboard: [
      [{ text: t('mtg.btn_move'), data: cb('mt', 'mv', id) }, { text: t(other === 'virtual' ? 'mtg.btn_to_virtual' : 'mtg.btn_to_in_person'), data: cb('mt', 'mode', id, other) }],
      [{ text: t('mtg.btn_host'), data: cb('mt', 'host', id) }, { text: t('mtg.btn_length'), data: cb('mt', 'len', id) }],
      m.mode === 'virtual'
        ? [{ text: t('mtg.btn_link'), data: cb('mt', 'lk', id) }, ...(m.link && !m.linkFromRoom ? [{ text: t('mtg.btn_link_clear'), data: cb('mt', 'lkx', id) }] : [])]
        : [{ text: t('mtg.btn_place'), data: cb('mt', 'place', id) }],
      [m.status === 'skipped' ? { text: t('mtg.btn_unskip'), data: cb('mt', 'unskip', id) } : { text: t('mtg.btn_skip'), data: cb('mt', 'skip', id) }],
      [back(cb('mt', 'o', id))],
    ],
  };
}

export function moveView(m: MeetingView, l: MLookup): View {
  const id = enc(m.id);
  return {
    text: t('mtg.move_prompt', { title: m.title, when: when(m, l) }),
    keyboard: [
      // Buttons carry the target time, so a double tap moves only once.
      [
        { text: t('mtg.move_1h'), data: cb('mt', 'mvq', id, Math.round(m.start.plus({ hours: 1 }).toMillis() / 60_000).toString(36)) },
        { text: t('mtg.move_1d'), data: cb('mt', 'mvq', id, Math.round(m.start.plus({ days: 1 }).toMillis() / 60_000).toString(36)) },
      ],
      [back(cb('mt', 'c', id))],
    ],
  };
}

export function choices(title: string, opts: { label: string; data: string; selected?: boolean }[], backData: string, perRow = 2): View {
  return {
    text: title,
    keyboard: [
      ...grid(opts.map((o) => ({ text: o.selected ? `${G.done} ${o.label}` : o.label, data: o.data, ...(o.selected ? { style: 'primary' as const } : {}) })), perRow),
      [back(backData)],
    ],
  };
}

export function lengthChoices(current: number, data: (m: number) => string, backData: string): View {
  return choices(`<b>${t('mtg.length_title')}</b>`, DURATIONS.map((d) => ({ label: t('mtg.minutes', { n: d }), data: data(d), selected: d === current })), backData, 3);
}

// ---------- agenda ----------

function agendaGlyph(a: AgendaItemView): string {
  if (a.status === 'done') return G.done;
  if (a.source === 'carry') return '↪';
  if (a.task?.status === 'blocked') return G.blocked;
  if (a.task) return '⚑';
  return '✎';
}

export function agendaLine(a: AgendaItemView, n: number, l: MLookup): string {
  const who = a.task?.owner_user_id ? ` ${i(`· ${esc(l.names.get(a.task.owner_user_id) ?? '')}`)}` : '';
  const done = a.task?.status === 'done' ? ` ${i(t('mtg.task_done'))}` : '';
  const kind = a.task ? (a.task.status === 'blocked' ? t('mtg.ag_blocked') : t('mtg.ag_task')) : a.source === 'carry' ? t('mtg.ag_carried') : '';
  return `${agendaGlyph(a)} ${b(String(n))}  ${kind ? `${i(kind)} ` : ''}${esc(clip(a.text, 80))}${who}${done}`;
}

export function agendaView(m: MeetingView, items: AgendaItemView[], l: MLookup): View {
  const id = enc(m.id);
  return {
    text: `📋 ${b(t('mtg.agenda_title'))} ${G.dot} ${esc(m.title)}\n${i(when(m, l))}\n${RULE}\n${items.map((a, idx) => agendaLine(a, idx + 1, l)).join('\n') || i(t('mtg.agenda_empty'))}\n\n${i(t('mtg.agenda_hint'))}`,
    keyboard: [
      ...grid(items.map((a, idx) => ({ text: String(idx + 1), data: cb('mt', 'ai', enc(a.id)) })), 6),
      [{ text: t('mtg.btn_add_item'), data: cb('mt', 'aadd', id), style: 'primary' }, { text: t('common.refresh'), data: cb('mt', 'ag', id) }],
      [back(cb('mt', 'o', id))],
    ],
  };
}

export function agendaItemView(a: AgendaRow): View {
  const id = enc(a.id);
  return {
    text: `${b(t('mtg.item_title'))}\n${esc(a.text)}`,
    keyboard: [
      [
        a.status === 'done' ? { text: t('mtg.btn_item_reopen'), data: cb('mt', 'aio', id) } : { text: t('mtg.btn_item_done'), data: cb('mt', 'aid', id), style: 'success' },
        { text: t('mtg.btn_item_up'), data: cb('mt', 'aiu', id) },
      ],
      [{ text: t('mtg.btn_item_action'), data: cb('mt', 'aia', id) }, { text: t('mtg.btn_item_drop'), data: cb('mt', 'aix', id) }],
      [back(cb('mt', 'ag', enc(a.meeting_id)))],
    ],
  };
}

// ---------- reminders ----------

export function reminderView(m: MeetingView, slot: string, agenda: AgendaItemView[], l: MLookup): View {
  const id = enc(m.id);
  const missingLink = m.mode === 'virtual' && !m.link;
  const head =
    slot === 'eve' ? t('mtg.rem_tomorrow', { time: fmtTime(m.start, l.fmt) })
    : slot === 'start' ? (missingLink ? t('mtg.rem_start_nolink') : t('mtg.rem_start'))
    : t('mtg.rem_in', { minutes: Number(slot.slice(1)) });
  const top = agenda.filter((a) => a.status === 'open').slice(0, 4);
  const text = [
    `${slot === 'start' && missingLink ? G.warn : '◉'} ${b(esc(m.title))} ${G.dot} ${b(head)}`,
    when(m, l),
    ...whereLines(m, l),
    top.length ? `\n${b(t('mtg.agenda_title'))}\n${top.map((a, idx) => agendaLine(a, idx + 1, l)).join('\n')}${agenda.length > top.length ? `\n${i(t('digest.more', { n: agenda.length - top.length }))}` : ''}` : '',
  ].filter((x) => x !== '').join('\n');
  const venue = m.mode === 'in_person' && m.place?.latitude != null && m.place.longitude != null && (slot === 'eve' || slot === 'b60' || slot === 'start')
    ? { latitude: m.place.latitude, longitude: m.place.longitude, title: m.place.name, address: m.place.address ?? '' }
    : undefined;
  return {
    text,
    keyboard: [
      joinButton(m),
      missingLink ? [{ text: t('mtg.btn_add_link'), data: cb('mt', 'lk', id), style: 'primary' }] : [],
      rsvpButtons(m, l),
      [{ text: t('mtg.btn_agenda'), data: cb('mt', 'ag', id) }, { text: t('rem.btn_open'), data: cb('mt', 'o', id) }],
    ],
    ...(venue ? { venue } : {}),
  };
}

export function linkNagView(m: MeetingView, l: MLookup): View {
  return {
    text: `${G.warn} ${b(t('mtg.nag_title'))}\n${esc(m.title)} ${G.dot} ${when(m, l)}\n\n${t('mtg.nag_body')}`,
    keyboard: [[{ text: t('mtg.btn_add_link'), data: cb('mt', 'lk', enc(m.id)), style: 'primary' }]],
  };
}

export function wrapView(m: MeetingView): View {
  return {
    text: `⏱ ${b(t('mtg.wrap_title'))}\n${esc(m.title)}\n\n${t('mtg.wrap_body')}`,
    keyboard: [[{ text: t('mtg.btn_end'), data: cb('mt', 'end', enc(m.id)), style: 'danger' }, { text: t('rem.btn_open'), data: cb('mt', 'o', enc(m.id)) }]],
  };
}

export function proposalView(m: MeetingView, p: ProposalRow, l: MLookup, proposer: string): View {
  const target = p.kind === 'skip' ? t('mtg.prop_skip') : t('mtg.prop_move', { when: `${fmtDay(localDate(fromDb(p.start_at!)), l.now)}, ${fmtTime(fromDb(p.start_at!), l.fmt)}` });
  return {
    text: `✕ ${b(t('mtg.prop_cant', { name: proposer }))}\n${esc(m.title)} ${G.dot} ${when(m, l)}\n\n${target}`,
    keyboard: [[
      { text: t('mtg.btn_accept'), data: cb('mp', 'a', enc(p.id)), style: 'success' },
      { text: t('mtg.btn_decline'), data: cb('mp', 'd', enc(p.id)) },
    ]],
  };
}


export function proposeOptionsView(m: MeetingView): View {
  const id = enc(m.id);
  return {
    text: `${b(t('mtg.propose_title'))}\n${esc(m.title)}\n\n${i(t('mtg.propose_hint'))}`,
    keyboard: [
      [{ text: t('mtg.prop_tom'), data: cb('mp', 'n', id, 'tom') }, { text: t('mtg.prop_2d'), data: cb('mp', 'n', id, '2d') }],
      [{ text: t('mtg.prop_custom'), data: cb('mp', 'n', id, 'custom') }, { text: t('mtg.prop_skip_btn'), data: cb('mp', 'n', id, 'skip') }],
      [{ text: t('mtg.prop_none'), data: cb('mp', 'n', id, 'none') }],
    ],
  };
}

// ---------- summary & history ----------

export function summaryView(s: MeetingSummary, l: MLookup): View {
  const m = s.meeting;
  const length = m.startedAt && m.endedAt ? Math.max(1, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60_000)) : null;
  const section = (title: string, lines: string[]) => (lines.length ? `${b(title)}\n${lines.join('\n')}` : '');
  const taskLines = s.tasks.map((x) => {
    const due = x.due_date ? fmtDay(x.due_date, l.now) : t('task.no_due');
    return `${STATUS_GLYPH[x.status]} ${esc(x.title)} ${i(`· ${esc(x.owner_name ?? t('task.unassigned'))} · ${due}`)} ${code(`T${x.id}`)}`;
  });
  const text = [
    `📄 ${b(t('mtg.summary_title'))} ${G.dot} ${esc(m.title)}`,
    i(`${when(m, l)}${length ? ` ${G.dot} ${t('mtg.minutes', { n: length })}` : ''}`),
    rsvpLine(m, l),
    RULE,
    section(t('mtg.sum_decisions'), s.decisions.map((d) => `◆ ${esc(d.text)}`)),
    section(t('mtg.sum_tasks'), taskLines),
    section(t('mtg.sum_questions'), s.questions.map((q) => `? ${esc(q.text)}`)),
    section(t('mtg.sum_notes'), s.notes.map((n) => `✎ ${esc(n.text)}`)),
    s.decisions.length + s.tasks.length + s.questions.length + s.notes.length === 0 ? i(t('mtg.sum_empty')) : '',
    s.questions.length && s.carriedTo ? i(t('mtg.sum_carried', { when: fmtDay(localDate(s.carriedTo.start), l.now) })) : '',
  ].filter(Boolean).join('\n\n');
  return { text, keyboard: [[{ text: t('mtg.btn_history'), data: cb('mt', 'h', '0') }, menuBtn]] };
}

export function historyView(items: MeetingView[], total: number, page: number, pageSize: number, l: MLookup): View {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const lines = items.map((m, idx) => {
    const att = m.rsvps.filter((r) => r.status !== 'no').length;
    const len = m.startedAt && m.endedAt ? t('mtg.minutes', { n: Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60_000) }) : null;
    const status = m.status === 'done' ? t('mtg.status.done_short') : m.status === 'skipped' ? t('mtg.status.skipped') : t('mtg.status.no_record');
    return `${b(String(page * pageSize + idx + 1))}  ${MODE_GLYPH[m.mode]} ${esc(m.title)} ${G.dot} ${fmtDay(localDate(m.start), l.now)}\n      ${i([status, len, att ? t('mtg.attended', { n: att }) : null].filter(Boolean).join(' · '))}`;
  });
  const nav: Btn[] = pages > 1 ? [
    { text: G.prev, data: cb('mt', 'h', String(Math.max(0, page - 1))) },
    { text: `${page + 1}/${pages}`, data: cb('mt', 'h', String(page)) },
    { text: G.next, data: cb('mt', 'h', String(Math.min(pages - 1, page + 1))) },
  ] : [];
  return {
    text: `🕘 ${b(t('mtg.history_title'))}\n${RULE}\n${lines.join('\n') || i(t('mtg.history_empty'))}`,
    keyboard: [...grid(items.map((m, idx) => ({ text: String(page * pageSize + idx + 1), data: cb('mt', 'o', enc(m.id)) })), 4), nav, [back(cb('mt', 'l', '0'))]],
  };
}

// ---------- slots & places ----------

export function seriesListView(series: SeriesRow[], places: PlaceRow[], l: MLookup): View {
  const lines = series.map((s, idx) =>
    `${b(String(idx + 1))}  ${MODE_GLYPH[s.mode]} ${b(esc(s.title))}${s.active ? '' : ` ${i(t('mtg.paused'))}`}\n      ${WEEKDAYS[s.weekday]} ${s.time} ${G.dot} ${t('mtg.minutes', { n: s.duration_min })}${s.mode === 'in_person' ? ` ${G.dot} ${esc(places.find((p) => p.id === s.place_id)?.name ?? t('mtg.default_place'))}` : s.room_url ? ` ${G.dot} 🔗 ${t('mtg.room')}` : ''}`,
  );
  void l;
  return {
    text: `⚙ ${b(t('mtg.slots_title'))}\n${RULE}\n${lines.join('\n')}\n\n${i(t('mtg.slots_hint'))}`,
    keyboard: [...grid(series.map((s, idx) => ({ text: String(idx + 1), data: cb('mt', 'se', enc(s.id)) })), 4), [back(cb('mt', 'l', '0'))]],
  };
}

export function seriesView(s: SeriesRow, places: PlaceRow[]): View {
  const id = enc(s.id);
  const other = s.mode === 'virtual' ? 'in_person' : 'virtual';
  const place = places.find((p) => p.id === s.place_id);
  return {
    text: [
      `⚙ ${b(esc(s.title))}${s.active ? '' : ` ${i(t('mtg.paused'))}`}`,
      `${WEEKDAYS[s.weekday]} ${G.dot} ${s.time} ${G.dot} ${t('mtg.minutes', { n: s.duration_min })}`,
      `${MODE_GLYPH[s.mode]} ${s.mode === 'virtual' ? t('mtg.virtual') : t('mtg.in_person')}`,
      s.mode === 'virtual' ? `🔗 ${s.room_url ? esc(shortMeet(s.room_url)) : i(t('mtg.no_room'))}` : `📍 ${esc(place?.name ?? t('mtg.default_place'))}`,
      '',
      i(t('mtg.series_hint')),
    ].join('\n'),
    keyboard: [
      [{ text: t('mtg.btn_day'), data: cb('mt', 'sday', id) }, { text: t('mtg.btn_time'), data: cb('mt', 'stime', id) }, { text: t('mtg.btn_length'), data: cb('mt', 'slen', id) }],
      [{ text: t(other === 'virtual' ? 'mtg.btn_to_virtual' : 'mtg.btn_to_in_person'), data: cb('mt', 'smode', id, other) },
        s.mode === 'virtual' ? { text: t('mtg.btn_room'), data: cb('mt', 'sroom', id) } : { text: t('mtg.btn_place'), data: cb('mt', 'splace', id) }],
      [s.active ? { text: t('mtg.btn_pause'), data: cb('mt', 'sact', id, '0') } : { text: t('mtg.btn_resume'), data: cb('mt', 'sact', id, '1'), style: 'primary' }],
      [back(cb('mt', 's', '0'))],
    ],
  };
}

export function dayChoices(s: SeriesRow): View {
  return choices(`<b>${t('mtg.day_title')}</b>`, [1, 2, 3, 4, 5, 6, 7].map((d) => ({ label: WEEKDAYS[d]!, data: cb('mt', 'sday', enc(s.id), String(d)), selected: s.weekday === d })), cb('mt', 'se', enc(s.id)), 3);
}

export function placesView(places: PlaceRow[]): View {
  return {
    text: `📍 ${b(t('mtg.places_title'))}\n${RULE}\n${places.map((p, idx) => `${b(String(idx + 1))}  ${p.is_default ? '★ ' : ''}${placeText(p)}${p.latitude != null ? ' 📌' : ''}`).join('\n') || i(t('mtg.places_empty'))}`,
    keyboard: [
      ...grid(places.map((p, idx) => ({ text: String(idx + 1), data: cb('mt', 'po', enc(p.id)) })), 6),
      [{ text: t('mtg.btn_new_place'), data: cb('mt', 'pn', '0'), style: 'primary' }],
      [back(cb('mt', 'l', '0'))],
    ],
  };
}

export function placeView(p: PlaceRow): View {
  const id = enc(p.id);
  return {
    text: `📍 ${placeText(p)}\n${p.latitude != null ? `📌 ${p.latitude.toFixed(5)}, ${p.longitude!.toFixed(5)}` : i(t('mtg.no_pin'))}${p.is_default ? `\n★ ${t('mtg.is_default')}` : ''}`,
    keyboard: [
      [{ text: t('mtg.btn_pe_name'), data: cb('mt', 'pe', id, 'name') }, { text: t('mtg.btn_pe_address'), data: cb('mt', 'pe', id, 'address') }, { text: t('mtg.btn_pe_notes'), data: cb('mt', 'pe', id, 'notes') }],
      [{ text: t('mtg.btn_pin'), data: cb('mt', 'ppin', id) }, ...(p.is_default ? [] : [{ text: t('mtg.btn_default'), data: cb('mt', 'pdef', id) }])],
      [back(cb('mt', 'pl', '0'))],
    ],
    ...(p.latitude != null && p.longitude != null ? { venue: { latitude: p.latitude, longitude: p.longitude, title: p.name, address: p.address ?? '' } } : {}),
  };
}

