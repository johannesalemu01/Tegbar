/**
 * Minimal Google OAuth 2.0 + Calendar v3 client over fetch (no SDK).
 *   auth:   https://accounts.google.com/o/oauth2/v2/auth  (access_type=offline, prompt=consent)
 *   token:  https://oauth2.googleapis.com/token
 *   revoke: https://oauth2.googleapis.com/revoke
 *   events: https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events  (conferenceDataVersion=1)
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export class GoogleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
  /** The grant is gone (revoked, expired, Testing-mode 7-day limit) — reconnect needed. */
  get needsReconnect(): boolean {
    return this.code === 'invalid_grant' || this.status === 401;
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface GoogleEvent {
  id: string;
  status?: string;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class GoogleClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {}

  authUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: CALENDAR_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  private async form(url: string, body: Record<string, string>): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    } catch (err) {
      throw new GoogleError(0, 'network', err instanceof Error ? err.message : 'network error');
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(res.status, data.error ?? 'error', data.error_description ?? `HTTP ${res.status}`);
    return data;
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
    const d = await this.form('https://oauth2.googleapis.com/token', {
      code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code',
    });
    return { accessToken: d.access_token, refreshToken: d.refresh_token ?? null, expiresIn: Number(d.expires_in ?? 3600) };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const d = await this.form('https://oauth2.googleapis.com/token', {
      refresh_token: refreshToken, client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'refresh_token',
    });
    return { accessToken: d.access_token, expiresIn: Number(d.expires_in ?? 3600) };
  }

  async revoke(token: string): Promise<void> {
    await this.form('https://oauth2.googleapis.com/revoke', { token }).catch(() => undefined);
  }

  private async call<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://www.googleapis.com/calendar/v3${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new GoogleError(0, 'network', err instanceof Error ? err.message : 'network error');
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(res.status, data.error?.status ?? data.error?.errors?.[0]?.reason ?? 'error', data.error?.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** The connected account's primary calendar id is its email address. */
  async primaryCalendarId(accessToken: string): Promise<string> {
    return (await this.call<{ id: string }>(accessToken, 'GET', '/calendars/primary')).id;
  }

  insertEvent(token: string, calendarId: string, event: Record<string, unknown>, sendUpdates: 'all' | 'none'): Promise<GoogleEvent> {
    return this.call(token, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`, event);
  }

  patchEvent(token: string, calendarId: string, eventId: string, event: Record<string, unknown>, sendUpdates: 'all' | 'none'): Promise<GoogleEvent> {
    return this.call(token, 'PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=${sendUpdates}`, event);
  }

  getEvent(token: string, calendarId: string, eventId: string): Promise<GoogleEvent> {
    return this.call(token, 'GET', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }
}

/** Meet URL from an event: hangoutLink, else the video entry point. */
export function meetUrlOf(e: GoogleEvent): string | null {
  return e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;
}

/** Deterministic event id (base32hex: 0-9 a-v, 5–1024 chars) → inserts are idempotent. */
export function eventIdFor(workspaceId: number, meetingId: number): string {
  return `tegbar0${workspaceId.toString(32)}0${meetingId.toString(32)}`.toLowerCase();
}
