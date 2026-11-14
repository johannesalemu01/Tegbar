import { Api } from 'grammy';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { installApiGuard } from '../src/core/telegram/guard.js';

function fakeApi(responses: any[]) {
  const api = new Api('0:TEST');
  const seen: string[] = [];
  // The base transformer stands in for the network.
  api.config.use(async (_prev, method) => {
    seen.push(method);
    return responses.shift();
  });
  return { api, seen };
}

describe('telegram api guard', () => {
  it('retries 429 after retry_after', async () => {
    vi.useFakeTimers();
    const { api, seen } = fakeApi([
      { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } },
      { ok: true, result: true },
    ]);
    installApiGuard(api, pino({ level: 'silent' }), async () => undefined);
    const p = api.raw.deleteMyCommands({});
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe(true);
    expect(seen).toHaveLength(2);
    vi.useRealTimers();
  });

  it('reports 403 so the user is marked blocked, and surfaces the error', async () => {
    const { api } = fakeApi([{ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }]);
    const blocked: number[] = [];
    installApiGuard(api, pino({ level: 'silent' }), async (id) => void blocked.push(id));
    await expect(api.sendMessage(1234, 'hi')).rejects.toThrow(/blocked/);
    expect(blocked).toEqual([1234]);
  });

  it('gives up on absurd retry_after values', async () => {
    const { api, seen } = fakeApi([{ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3600 } }]);
    installApiGuard(api, pino({ level: 'silent' }), async () => undefined);
    await expect(api.raw.deleteMyCommands({})).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
