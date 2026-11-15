import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, parseKey, seal } from '../src/core/crypto/secretbox.js';
import { CALENDAR_SCOPE, GoogleClient, eventIdFor, meetUrlOf } from '../src/modules/gcal/google.js';

describe('secretbox', () => {
  it('round-trips and rejects tampering / wrong keys', () => {
    const key = randomBytes(32);
    const s = seal('1//refresh-token', key);
    expect(s.startsWith('v1:')).toBe(true);
    expect(s).not.toContain('refresh-token');
    expect(open(s, key)).toBe('1//refresh-token');
    expect(() => open(s, randomBytes(32))).toThrow();
    const bad = `v1:${Buffer.from(Buffer.from(s.slice(3), 'base64').map((b, i) => (i === 14 ? b ^ 1 : b))).toString('base64')}`;
    expect(() => open(bad, key)).toThrow();
    expect(parseKey(randomBytes(32).toString('base64'))).not.toBeNull();
    expect(parseKey('short')).toBeNull();
  });
});

describe('google helpers', () => {
  it('builds an offline consent URL with the events scope', () => {
    const u = new URL(new GoogleClient('cid', 'sec', 'https://t.example.com/oauth/google/callback').authUrl('st8'));
    expect(u.searchParams.get('scope')).toBe(CALENDAR_SCOPE);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('state')).toBe('st8');
  });
  it('event ids are valid base32hex and stable', () => {
    const id = eventIdFor(1, 1234);
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(eventIdFor(1, 1234)).toBe(id);
    expect(eventIdFor(1, 1235)).not.toBe(id);
  });
  it('reads the Meet link from hangoutLink or entry points', () => {
    expect(meetUrlOf({ id: 'x', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' })).toBe('https://meet.google.com/aaa-bbbb-ccc');
    expect(meetUrlOf({ id: 'x', conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:1' }, { entryPointType: 'video', uri: 'https://meet.google.com/x' }] } })).toBe('https://meet.google.com/x');
    expect(meetUrlOf({ id: 'x' })).toBeNull();
  });
});
