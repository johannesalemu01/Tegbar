import type { Api, RawApi } from 'grammy';
import type { Logger } from 'pino';

/**
 * API transformer:
 *  - 429 Too Many Requests: wait `retry_after` seconds and retry (max 3 times, max 60 s wait).
 *  - 403 Forbidden on a send (user blocked the bot): report it so we stop messaging them.
 * Other errors are returned unchanged and surface as GrammyError.
 */
export function installApiGuard(api: Api<RawApi>, log: Logger, onBlocked: (chatId: number) => Promise<void>): void {
  api.config.use(async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      const res = await prev(method, payload, signal);
      if (res.ok) return res;
      const retryAfter = res.parameters?.retry_after;
      if (res.error_code === 429 && retryAfter !== undefined && retryAfter <= 60 && attempt < 3) {
        log.warn({ method, retryAfter, attempt }, 'telegram rate limit, retrying');
        await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
        continue;
      }
      if (res.error_code === 403 && payload && typeof payload === 'object' && 'chat_id' in payload) {
        const chatId = Number((payload as { chat_id: unknown }).chat_id);
        if (Number.isFinite(chatId)) {
          log.warn({ method, chatId }, 'telegram 403: user blocked the bot or chat unavailable');
          await onBlocked(chatId).catch(() => undefined);
        }
      }
      return res;
    }
  });
}
