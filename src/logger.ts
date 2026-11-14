import pino, { type Logger } from 'pino';

const secrets = new Set<string>();

/** Register a secret value so it is scrubbed from every log line. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: ['token', '*.token', 'BOT_TOKEN', 'SETUP_CODE', 'WEBHOOK_SECRET', 'payload.text', 'config'],
      censor: '[REDACTED]',
    },
    serializers: {
      err: (err: unknown) => {
        const e = pino.stdSerializers.err(err as Error);
        if (e.message) e.message = scrub(e.message);
        if (e.stack) e.stack = scrub(e.stack);
        return e;
      },
    },
    hooks: {
      logMethod(args, method) {
        // Scrub secrets that may appear inside free-form messages.
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as typeof args;
        return method.apply(this, scrubbed);
      },
    },
  });
}
