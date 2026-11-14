import { createServer, type Server } from 'node:http';
import { webhookCallback } from 'grammy';
import { createApp } from './app.js';
import { buildApiRouter } from './core/api/routes.js';
import { createApiHandler } from './core/api/server.js';
import { loadConfig } from './config.js';
import { openDatabase } from './core/db/database.js';
import { createBot } from './core/telegram/bot.js';
import { systemClock } from './core/time.js';
import { setButtonStyles } from './core/ui/keyboard.js';
import { createLogger, registerSecret } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  for (const s of [config.BOT_TOKEN, config.SETUP_CODE, config.WEBHOOK_SECRET]) registerSecret(s);
  const log = createLogger(config.LOG_LEVEL);
  setButtonStyles(config.BUTTON_STYLES === 'on');

  const database = openDatabase(config.databasePath);
  const app = await createApp({
    database,
    clock: systemClock,
    log,
    setupCode: config.SETUP_CODE,
    seatNames: { A: config.PERSON_A_NAME, B: config.PERSON_B_NAME },
    workspaceName: config.WORKSPACE_NAME,
    timezone: config.TIMEZONE,
  });

  let lastUpdateAt = Date.now();
  const { bot, alerter, syncCommands, scheduler } = createBot(app, config.BOT_TOKEN, { onUpdate: () => (lastUpdateAt = Date.now()) });
  await bot.init();
  log.info({ bot: bot.botInfo.username, mode: config.BOT_MODE }, 'bot ready');
  await syncCommands().catch((err) => log.warn({ err }, 'could not sync commands'));

  // Re-plan every reminder/digest job from current data (idempotent), then start
  // the persistent scheduler. The first tick catches up on anything missed while down.
  await app.planner.syncAll(app.workspace.id);
  await app.meetingPlanner.syncAll(app.workspace.id);
  scheduler.start(30_000);
  log.info('scheduler started (30 s poll)');

  const webhookPath = '/telegram';
  const handleUpdate =
    config.BOT_MODE === 'webhook'
      ? webhookCallback(bot, 'http', { secretToken: config.WEBHOOK_SECRET!, onTimeout: 'return' })
      : null;

  const apiHandler =
    config.API_ENABLED === 'on'
      ? createApiHandler(app, buildApiRouter(), {
          botToken: config.BOT_TOKEN,
          maxAgeSec: config.API_INITDATA_MAX_AGE,
          corsOrigin: config.API_CORS_ORIGIN,
          onError: (err, where) => alerter.critical(err, where),
        })
      : null;

  // HTTP: /healthz for Docker and hosts; /telegram in webhook mode; /api/v1 when enabled.
  const server: Server = createServer(async (req, res) => {
    if (apiHandler && (await apiHandler(req, res))) return;
    if (req.method === 'GET' && req.url === '/healthz') {
      try {
        app.database.raw.prepare('select 1').get();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: config.BOT_MODE, lastUpdateSecondsAgo: Math.round((Date.now() - lastUpdateAt) / 1000) }));
      } catch {
        res.writeHead(503).end('{"ok":false}');
      }
      return;
    }
    if (handleUpdate && req.method === 'POST' && req.url === webhookPath) {
      // grammY verifies the X-Telegram-Bot-Api-Secret-Token header and replies 401 on mismatch.
      await handleUpdate(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(config.PORT, config.HOST, resolve));
  log.info({ port: config.PORT }, 'http server listening');

  if (config.BOT_MODE === 'webhook') {
    const url = `${config.WEBHOOK_URL!.replace(/\/$/, '')}${webhookPath}`;
    await bot.api.setWebhook(url, {
      secret_token: config.WEBHOOK_SECRET!,
      allowed_updates: ['message', 'callback_query'],
    });
    log.info('webhook registered');
  } else {
    await bot.api.deleteWebhook();
    void bot
      .start({ allowed_updates: ['message', 'callback_query'], onStart: () => log.info('long polling started') })
      .catch(async (err) => {
        await alerter.critical(err, 'polling');
        process.exit(1);
      });
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await scheduler.stop();
      if (config.BOT_MODE === 'polling') await bot.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await database.close();
    } finally {
      log.info('bye');
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => void alerter.critical(err, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    void alerter.critical(err, 'uncaughtException').finally(() => process.exit(1));
  });
}

main().catch((err) => {
  // Config errors land here before the logger exists; never print secrets.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  if (/401/.test(msg)) console.error('Telegram rejected BOT_TOKEN. Copy it again from @BotFather (/mybots → API Token).');
  process.exit(1);
});
