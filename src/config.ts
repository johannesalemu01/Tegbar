import { z } from 'zod';

/**
 * All configuration comes from environment variables. Secrets (BOT_TOKEN,
 * SETUP_CODE, WEBHOOK_SECRET) are never logged — see logger.ts redaction.
 */
const schema = z
  .object({
    BOT_TOKEN: z.string().min(20, 'BOT_TOKEN looks too short — copy it from @BotFather'),
    SETUP_CODE: z.string().min(12, 'SETUP_CODE must be at least 12 characters'),
    DATA_DIR: z.string().default('./data'),
    DATABASE_PATH: z.string().optional(),
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    WEBHOOK_URL: z.string().url().optional(),
    WEBHOOK_SECRET: z.string().optional(),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    TIMEZONE: z.string().default('Africa/Addis_Ababa'),
    WORKSPACE_NAME: z.string().default('Tegbar'),
    PERSON_A_NAME: z.string().optional(),
    PERSON_B_NAME: z.string().optional(),
    BUTTON_STYLES: z.enum(['on', 'off']).default('on'),
  })
  .superRefine((v, ctx) => {
    if (v.BOT_MODE === 'webhook') {
      if (!v.WEBHOOK_URL) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_URL'], message: 'required in webhook mode' });
      if (!v.WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{16,256}$/.test(v.WEBHOOK_SECRET)) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_SECRET'],
          message: 'required in webhook mode: 16-256 chars of A-Z a-z 0-9 _ -',
        });
      }
    }
  });

export type Config = z.infer<typeof schema> & { databasePath: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}\nSee .env.example.`);
  }
  const v = parsed.data;
  return { ...v, databasePath: v.DATABASE_PATH ?? `${v.DATA_DIR.replace(/\/$/, '')}/tegbar.db` };
}
