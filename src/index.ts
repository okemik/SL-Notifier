import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { safeError } from "./errors.js";
import { prepareDeviation } from "./format.js";
import { Notifier } from "./notifier.js";
import { fetchDeviationResult } from "./sl.js";
import { StateStore } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

const config = loadConfig();
const store = new StateStore(config.stateDb);
const controller = new AbortController();
const notifier = new Notifier({
  store,
  fetch: () => fetchDeviationResult({
    transportMode: config.transportMode, lines: config.lines, future: config.future, signal: controller.signal,
  }),
  prepare: deviation => prepareDeviation(deviation, {
    preferredLang: config.preferredLang, transportMode: config.transportMode,
    timeZone: config.timeZone, translate: config.translateEnabled, signal: controller.signal,
  }),
  send: text => sendTelegramMessage({ token: config.botToken, chatId: config.chatId, text, signal: controller.signal }),
  intervalMs: config.intervalMs, pruneDays: config.pruneDays,
  abort: () => controller.abort(),
  log: message => console.error(message),
});
const server = createApp(notifier, config.checkApiKey).listen(config.port, () => {
  console.log(`SL notifier listening on port ${config.port}`);
  notifier.start();
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { await notifier.stop(); store.close(); }
  catch (cause) { console.error(`Shutdown failed: ${safeError(cause)}`); process.exitCode = 1; }
}
server.on("error", cause => {
  console.error(`HTTP server failed: ${safeError(cause)}`);
  process.exitCode = 1;
  void shutdown();
});
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
