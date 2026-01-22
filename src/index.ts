import "dotenv/config";
import express from "express";

import { StateStore } from "./state.js";
import { fetchDeviations } from "./sl.js";
import { formatDeviation } from "./format.js";
import { sendTelegramMessage } from "./telegram.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in env");
}

const BOT_TOKEN: string = TELEGRAM_BOT_TOKEN;
const CHAT_ID: string = TELEGRAM_CHAT_ID;

const TRANSPORT_MODE = process.env.TRANSPORT_MODE || "METRO";
const FUTURE = (process.env.FUTURE || "false").toLowerCase() === "true";
const LINES = (process.env.LINES || "17,18,19")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

const PORT = Number(process.env.PORT || "3000");
const PREFERRED_LANG = process.env.PREFERRED_LANG || "sv";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || "60000");
const PRUNE_DAYS = Number(process.env.PRUNE_DAYS || "14");

const store = new StateStore(process.env.STATE_DB || "state.db");

let tick = 0;
let isRunning = false;

async function checkAndNotify() {
  if (isRunning) return;
  isRunning = true;
  try {
    const deviations = await fetchDeviations({
      transportMode: TRANSPORT_MODE,
      lines: LINES.length ? LINES : [17, 18, 19],
      future: FUTURE,
    });

    for (const d of deviations) {
      const key = `${d.deviation_case_id}:${d.version}`;
      if (store.alreadySent(key)) continue;

      const text = formatDeviation(d, PREFERRED_LANG);
      await sendTelegramMessage({
        token: BOT_TOKEN,
        chatId: CHAT_ID,
        text,
      });

      store.markSent(key);
    }

    tick += 1;
    if (tick % 60 === 0) store.prune(PRUNE_DAYS);
  } catch (err: any) {
    console.error("checkAndNotify error:", err?.message ?? err);
  } finally {
    isRunning = false;
  }
}

checkAndNotify();

setInterval(checkAndNotify, Math.max(10_000, CHECK_INTERVAL_MS)); // minimum 10s safeguard

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/check", async (_req, res) => {
  await checkAndNotify();
  res.json({ ok: true, ran: true });
});
app.get("/", (_req, res) => res.send("SL Green line Telegram notifier (near real-time) is running."));

app.listen(PORT, () => console.log(`Server up on :${PORT}`));
