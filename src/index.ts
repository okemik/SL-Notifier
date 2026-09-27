import "dotenv/config";
import { createApp } from "./app.js";
import { CommandPoller, respond } from "./commands.js";
import { loadConfig } from "./config.js";
import { safeError } from "./errors.js";
import { prepareDeviation } from "./format.js";
import { Notifier } from "./notifier.js";
import { fetchDeviationResult } from "./sl.js";
import { StateStore } from "./state.js";
import { shutdownService } from "./shutdown.js";
import { createTelegramApi, sendTelegramMessage } from "./telegram.js";
import { createLibreTranslateTranslator } from "./translate.js";

const config = loadConfig();
const store = new StateStore(config.stateDb);
const controller = new AbortController();
const translator = config.translateBackend === "libre"
  ? createLibreTranslateTranslator({ endpoint: config.translateEndpoint })
  : undefined;
const notifier = new Notifier({
  store,
  fetch: () => fetchDeviationResult({
    transportMode: config.transportMode, lines: config.lines, future: config.future, signal: controller.signal,
  }),
  prepare: deviation => prepareDeviation(deviation, {
    preferredLang: config.preferredLang, transportMode: config.transportMode,
    timeZone: config.timeZone, translate: config.translateEnabled, signal: controller.signal,
    log: message => console.error(message),
    translator,
  }),
  send: text => sendTelegramMessage({ token: config.botToken, chatId: config.chatId, text, signal: controller.signal }),
  intervalMs: config.intervalMs, pruneDays: config.pruneDays, manualIntervalMs: config.manualIntervalMs,
  abort: () => controller.abort(),
  log: message => console.error(message),
});
const commands = config.commandsEnabled ? new CommandPoller({
  api: createTelegramApi(config.botToken),
  chatId: config.chatId,
  handle: command => respond(command, {
    notifier, transportMode: config.transportMode, lines: config.lines, future: config.future,
    intervalMs: config.intervalMs, timeZone: config.timeZone, preferredLang: config.preferredLang,
  }),
  // Replies share the alert sender, so they respect the same Telegram rate spacing.
  reply: (text, replyToMessageId) => sendTelegramMessage({
    token: config.botToken, chatId: config.chatId, text, replyToMessageId, signal: controller.signal,
  }),
  store, signal: controller.signal,
  log: message => console.error(message),
}) : undefined;
const server = createApp(notifier, config.checkApiKey).listen(config.port, () => {
  console.log(`SL notifier listening on port ${config.port}`);
  notifier.start();
  commands?.start();
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const drained = await shutdownService({
      closeHttp: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
      stop: async () => { await Promise.all([notifier.stop(), commands?.stop()]); },
      closeStore: () => store.close(),
    });
    if (!drained) {
      console.error("Shutdown exceeded 10 seconds; terminating with unfinished work.");
      process.exit(1);
    }
  } catch (cause) {
    console.error(`Shutdown failed: ${safeError(cause)}`);
    process.exit(1);
  }
}
server.on("error", cause => {
  console.error(`HTTP server failed: ${safeError(cause)}`);
  process.exitCode = 1;
  void shutdown();
});
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
