import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { extractDue, parseQuickAdd, type QuickAddContext } from '../src/modules/tasks/quickadd.js';

const ZONE = 'Africa/Addis_Ababa';
// Sunday 15 Nov 2026, 14:30 in Addis Ababa
const now = DateTime.fromISO('2026-11-15T14:30:00', { zone: ZONE });

const ctx = (over: Partial<QuickAddContext> = {}): QuickAddContext => ({
  now,
  meUserId: 1,
  members: [
    { userId: 1, handles: ['john', 'john_tg', 'yohannes'] },
    { userId: 2, handles: ['sami', 'sami_tg', 'samuel'] },
  ],
  projects: [
    { id: 10, code: 'GENERAL' },
    { id: 11, code: 'RIDEHOME' },
  ],
  areasByProject: new Map([
    [10, [{ id: 100, slug: 'finance' }, { id: 101, slug: 'legal' }]],
    [11, [{ id: 110, slug: 'sales' }, { id: 111, slug: 'engineering' }, { id: 112, slug: 'product' }]],
  ]),
  defaultProjectId: 11,
  ...over,
});

describe('quick add parser', () => {
  it('parses the full example', () => {
    const r = parseQuickAdd('Call MMCY tomorrow 10am @sami !high #ridehome #sales', ctx());
    expect(r).toMatchObject({
      title: 'Call MMCY', ownerUserId: 2, priority: 'high', projectId: 11, areaId: 110,
      due: { date: '2026-11-16', time: '10:00' }, issues: [],
    });
  });

  it('defaults: me, normal, current project, no date', () => {
    const r = parseQuickAdd('Write pitch deck', ctx());
    expect(r).toMatchObject({ title: 'Write pitch deck', ownerUserId: 1, priority: 'normal', projectId: 11, areaId: null, due: null, issues: [] });
  });

  it('accepts @partner / @friend as the other founder and @me', () => {
    expect(parseQuickAdd('x @friend', ctx()).ownerUserId).toBe(2);
    expect(parseQuickAdd('x @partner', ctx()).ownerUserId).toBe(2);
    expect(parseQuickAdd('x @me', ctx({ meUserId: 2 })).ownerUserId).toBe(2);
    expect(parseQuickAdd('x @Samuel', ctx()).ownerUserId).toBe(2);
  });

  it('explicit ISO dates with and without time', () => {
    expect(parseQuickAdd('Renew domain 2026-11-20 15:00', ctx()).due).toEqual({ date: '2026-11-20', time: '15:00' });
    expect(parseQuickAdd('Renew domain 2026-11-20', ctx()).due).toEqual({ date: '2026-11-20', time: null });
    expect(parseQuickAdd('Renew domain 2026-11-20', ctx()).title).toBe('Renew domain');
  });

  it('natural dates: weekday is date-only, "in 3 hours" has a time', () => {
    expect(parseQuickAdd('pay rent friday', ctx()).due).toEqual({ date: '2026-11-20', time: null });
    expect(parseQuickAdd('review in 3 hours', ctx()).due).toEqual({ date: '2026-11-15', time: '17:30' });
    expect(parseQuickAdd('send report 5pm sat', ctx()).due).toEqual({ date: '2026-11-21', time: '17:00' });
  });

  it('area tags resolve against the chosen project (General has no #sales)', () => {
    const r = parseQuickAdd('file taxes #general #finance', ctx());
    expect(r.projectId).toBe(10);
    expect(r.areaId).toBe(100);
    const bad = parseQuickAdd('pitch #general #sales', ctx());
    expect(bad.areaId).toBeNull();
    expect(bad.issues).toContainEqual({ kind: 'unknown_tag', value: 'sales' });
    expect(bad.title).toBe('pitch #sales');
  });

  it('area prefix match needs 3+ chars', () => {
    expect(parseQuickAdd('fix bug #eng', ctx()).areaId).toBe(111);
    expect(parseQuickAdd('fix bug #e', ctx()).areaId).toBeNull();
  });

  it('flags ambiguity: unknown owner, unknown priority, vague or past dates, multiple projects', () => {
    expect(parseQuickAdd('x @bob', ctx()).issues).toContainEqual({ kind: 'unknown_owner', value: 'bob' });
    expect(parseQuickAdd('x @bob', ctx()).ownerUserId).toBe(1);
    expect(parseQuickAdd('x !wow', ctx()).issues).toContainEqual({ kind: 'unknown_priority', value: 'wow' });
    expect(parseQuickAdd('launch in december', ctx()).issues.map((i) => i.kind)).toContain('vague_date');
    expect(parseQuickAdd('x 2026-01-02', ctx()).issues).toContainEqual({ kind: 'past_date' });
    expect(parseQuickAdd('x #ridehome #general', ctx()).issues).toContainEqual({ kind: 'multiple_projects' });
    expect(parseQuickAdd('@sami !high', ctx()).issues).toContainEqual({ kind: 'empty_title' });
  });

  it('keeps Amharic text intact and does not treat emails as owners', () => {
    const r = parseQuickAdd('ለአበበ ደውል ነገ 9am contact a@b.com', ctx());
    expect(r.title).toBe('ለአበበ ደውል contact a@b.com');
    expect(r.ownerUserId).toBe(1);
    expect(r.due).toEqual({ date: '2026-11-16', time: '09:00' });
    expect(r.issues).toEqual([]);
  });

  it('priority aliases', () => {
    expect(parseQuickAdd('x !h', ctx()).priority).toBe('high');
    expect(parseQuickAdd('x !low', ctx()).priority).toBe('low');
    expect(parseQuickAdd('x !l', ctx()).priority).toBe('low');
  });

  it('is independent of the server time zone: late evening in Addis', () => {
    // 23:30 Addis = 20:30 UTC; tests run with TZ=America/Los_Angeles (12:30 local)
    const late = DateTime.fromISO('2026-11-15T23:30:00', { zone: ZONE });
    expect(extractDue('tomorrow 8am', late).due).toEqual({ date: '2026-11-16', time: '08:00' });
    expect(extractDue('today', late).due).toEqual({ date: '2026-11-15', time: null });
  });

  it('rejects impossible ISO dates', () => {
    expect(extractDue('2026-02-30', now).due).toBeNull();
  });
});

describe('Amharic day words', () => {
  it('ዛሬ / ነገ / ከነገ ወዲያ', () => {
    expect(extractDue('ዛሬ 5pm', now).due).toEqual({ date: '2026-11-15', time: '17:00' });
    expect(extractDue('ነገ', now).due).toEqual({ date: '2026-11-16', time: null });
    expect(extractDue('ከነገ ወዲያ', now).due).toEqual({ date: '2026-11-17', time: null });
  });
});

describe('title cleanup around dates', () => {
  it('drops dangling prepositions', () => {
    expect(parseQuickAdd('Draft pitch deck in december', ctx()).title).toBe('Draft pitch deck');
    expect(parseQuickAdd('Pay hosting by friday', ctx()).title).toBe('Pay hosting');
    expect(parseQuickAdd('Ship release on 2026-11-20', ctx()).title).toBe('Ship release');
    expect(parseQuickAdd('Call Abebe at 3pm about pricing', ctx()).title).toBe('Call Abebe about pricing');
    expect(parseQuickAdd('Launch in december', ctx()).issues).toContainEqual({ kind: 'vague_date', value: 'december' });
  });
});
