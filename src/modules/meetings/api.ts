import { z } from 'zod';
import { ApiRaw, idParam, type ApiRouter } from '../../core/api/router.js';
import { fromDb } from '../../core/time.js';
import { buildIcs } from './ics.js';
import type { MeetingView } from './service.js';

export function meetingJson(m: MeetingView) {
  return {
    id: m.id, projectId: m.projectId, seriesId: m.seriesId, title: m.title, startAt: m.startAt, endAt: m.end.toUTC().toISO(),
    durationMin: m.durationMin, mode: m.mode, hostUserId: m.hostUserId, hostName: m.hostName, status: m.status, moved: m.moved,
    link: m.link, linkFromRoom: m.linkFromRoom,
    place: m.place ? { id: m.place.id, name: m.place.name, address: m.place.address, notes: m.place.notes, latitude: m.place.latitude, longitude: m.place.longitude } : null,
    rsvps: m.rsvps.map((r) => ({ userId: r.user_id, status: r.status, lateMinutes: r.late_minutes })),
    startedAt: m.startedAt, endedAt: m.endedAt,
  };
}

const patchBody = z.object({
  startAt: z.string().datetime({ offset: true }).optional(),
  mode: z.enum(['virtual', 'in_person']).optional(),
  hostUserId: z.number().int().positive().optional(),
  placeId: z.number().int().positive().optional(),
  link: z.string().max(200).nullable().optional(),
  durationMin: z.number().int().optional(),
}).strict();

export function meetingsApi(r: ApiRouter): void {
  r.get('/meetings', async ({ app, actor, query }) => {
    const limit = z.coerce.number().int().min(1).max(30).parse(query.get('limit') ?? '10');
    return (await app.meetings.upcoming(actor, limit)).map(meetingJson);
  });
  r.get('/meetings/history', async ({ app, actor, query }) => {
    const page = z.coerce.number().int().min(0).parse(query.get('page') ?? '0');
    const { items, total } = await app.meetings.history(actor, page, 20);
    return { items: items.map(meetingJson), total, page };
  });
  r.get('/meetings/:id', async (req) => {
    const id = idParam(req);
    await req.app.meetings.ensureAgenda(req.actor, id);
    const [m, agenda, outcomes] = await Promise.all([
      req.app.meetings.get(req.actor, id), req.app.meetings.agenda(req.actor, id), req.app.meetings.outcomes(req.actor, id),
    ]);
    return {
      ...meetingJson(m),
      agenda: agenda.map((a) => ({ id: a.id, source: a.source, text: a.text, status: a.status, taskId: a.task?.id ?? null, taskStatus: a.task?.status ?? null })),
      outcomes: outcomes.map((o) => ({ id: o.id, kind: o.kind, text: o.text, taskId: o.task_id })),
    };
  });
  r.get('/meetings/:id/ics', async (req) => {
    const m = await req.app.meetings.get(req.actor, idParam(req));
    const ics = buildIcs([{
      uid: `meeting-${m.id}@tegbar`, sequence: m.sequence, start: m.start, end: m.end, summary: m.title,
      ...(m.link ? { url: m.link } : {}), ...(m.mode === 'in_person' && m.place ? { location: m.place.name } : {}),
      cancelled: m.status === 'skipped' || m.status === 'cancelled', alarms: [60, 10],
    }], req.app.clock.now());
    return new ApiRaw(200, 'text/calendar; charset=utf-8', ics, `meeting-${m.id}.ics`);
  });
  r.post('/meetings/:id/rsvp', async (req) => {
    const b = z.object({ status: z.enum(['going', 'late', 'no']), lateMinutes: z.number().int().min(1).max(120).optional() }).strict().parse(req.body);
    const { meeting, changed } = await req.app.meetings.rsvp(req.actor, idParam(req), b.status, b.lateMinutes ?? null);
    return { meeting: meetingJson(meeting), changed };
  });
  r.patch('/meetings/:id', async (req) => {
    const id = idParam(req);
    const b = patchBody.parse(req.body);
    const s = req.app.meetings;
    if (b.startAt) await s.move(req.actor, id, fromDb(new Date(b.startAt).toISOString()));
    if (b.mode) await s.setMode(req.actor, id, b.mode);
    if (b.hostUserId) await s.setHost(req.actor, id, b.hostUserId);
    if (b.placeId) await s.setPlace(req.actor, id, b.placeId);
    if (b.link !== undefined) await s.setLink(req.actor, id, b.link);
    if (b.durationMin) await s.setDuration(req.actor, id, b.durationMin);
    return meetingJson(await s.get(req.actor, id));
  });
  r.post('/meetings/:id/skip', async (req) => meetingJson((await req.app.meetings.skip(req.actor, idParam(req))).meeting));
  r.post('/meetings/:id/unskip', async (req) => meetingJson((await req.app.meetings.unskip(req.actor, idParam(req))).meeting));
  r.post('/meetings/:id/agenda', async (req) => {
    const b = z.object({ text: z.string().min(1).max(300) }).strict().parse(req.body);
    return req.app.meetings.addAgendaItem(req.actor, idParam(req), b.text);
  });
  r.post('/meetings/:id/outcomes', async (req) => {
    const b = z.object({ kind: z.enum(['decision', 'question', 'note']), text: z.string().min(1).max(500) }).strict().parse(req.body);
    return req.app.meetings.addOutcome(req.actor, idParam(req), b.kind, b.text);
  });
  r.get('/places', async ({ app, actor }) => app.meetings.places(actor));
}
