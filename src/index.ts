import "dotenv/config";
import express from "express";

import { StateStore } from "./state.js";
import { fetchDeviations } from "./sl.js";
import { buildDeviationSummaries, formatDeviation } from "./format.js";
import type { Deviation } from "./types.js";
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
const PRUNE_DAYS = Number(process.env.PRUNE_DAYS || "14");

const store = new StateStore(process.env.STATE_DB || "state.db");

let tick = 0;
let isRunning = false;

const CRITICAL_EN_KEYWORDS = ["cancel", "cancelled", "suspended", "stopped", "no service"];
const CRITICAL_SV_KEYWORDS = ["inställd", "inställda", "ingen trafik", "trafiken står still"];

type PreparedDeviation = {
  deviation: Deviation;
  enSummary: string;
  svOriginal: string;
  isCritical: boolean;
  transportMode: string;
  lineGroup: "Green Line (17,18,19)" | "Line 40" | "Line 41";
};

function includesKeyword(text: string, keywords: string[]) {
  const lowered = text.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword));
}

function getLineNumbers(d: Deviation) {
  const numbers: number[] = [];
  for (const line of d.scope?.lines ?? []) {
    if (Number.isFinite(line.id)) numbers.push(line.id);
    if (line.designation) {
      const match = line.designation.match(/\d+/g);
      if (match) {
        for (const part of match) {
          const parsed = Number(part);
          if (Number.isFinite(parsed)) numbers.push(parsed);
        }
      }
    }
    if (line.name) {
      const match = line.name.match(/\d+/g);
      if (match) {
        for (const part of match) {
          const parsed = Number(part);
          if (Number.isFinite(parsed)) numbers.push(parsed);
        }
      }
    }
  }
  return numbers;
}

function resolveTransportMode(d: Deviation) {
  return (d.transport_mode ?? TRANSPORT_MODE).toUpperCase();
}

function resolveLineGroup(transportMode: string, lineNumbers: number[]) {
  if (transportMode === "METRO") {
    return "Green Line (17,18,19)";
  }
  if (transportMode === "TRAIN") {
    if (lineNumbers.includes(40)) return "Line 40";
    if (lineNumbers.includes(41)) return "Line 41";
  }
  throw new Error(`Unsupported grouping for ${transportMode} with lines ${lineNumbers.join(",")}`);
}

function buildGroupedMessage(critical: PreparedDeviation[], nonCritical: PreparedDeviation[]) {
  const lines: string[] = ["🚨 SL ALERTS", ""];

  const groupOrder: Array<{
    mode: string;
    lineGroup: PreparedDeviation["lineGroup"];
    title: string;
  }> = [
    { mode: "METRO", lineGroup: "Green Line (17,18,19)", title: "🚇 METRO – Green Line (17,18,19)" },
    { mode: "TRAIN", lineGroup: "Line 40", title: "🚆 PENDELTÅG – Line 40" },
    { mode: "TRAIN", lineGroup: "Line 41", title: "🚆 PENDELTÅG – Line 41" },
  ];

  const appendGroups = (items: PreparedDeviation[]) => {
    for (const group of groupOrder) {
      const groupItems = items.filter(
        (item) => item.transportMode === group.mode && item.lineGroup === group.lineGroup
      );
      if (!groupItems.length) continue;
      lines.push(group.title);
      for (const item of groupItems) {
        lines.push(`• ${item.enSummary}`);
        lines.push(`  🇸🇪 ${item.svOriginal}`);
      }
      lines.push("");
    }
    if (lines[lines.length - 1] === "") lines.pop();
  };

  if (critical.length > 0) {
    lines.push("🔥 CRITICAL ISSUES", "");
    appendGroups(critical);
    lines.push("");
  }

  if (nonCritical.length > 0) {
    lines.push("⚠️ OTHER ISSUES", "");
    appendGroups(nonCritical);
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const timestamp = new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  lines.push(`🕒 Checked at: ${timestamp}`);

  return lines.join("\n");
}

async function checkAndNotify() {
  try {
    const deviations = await fetchDeviations({
      transportMode: TRANSPORT_MODE,
      lines: LINES.length ? LINES : [17, 18, 19],
      future: FUTURE,
    });

    const newDeviations = deviations.filter((d) => {
      const key = `${d.deviation_case_id}:${d.version}`;
      return !store.alreadySent(key);
    });

    if (newDeviations.length > 0) {
      try {
        const prepared = await Promise.all(
          newDeviations.map(async (d) => {
            const { enSummary, svOriginal } = await buildDeviationSummaries(d, PREFERRED_LANG);
            const svLower = svOriginal.toLowerCase();
            const enLower = enSummary.toLowerCase();
            const isCritical =
              includesKeyword(enLower, CRITICAL_EN_KEYWORDS) ||
              includesKeyword(svLower, CRITICAL_SV_KEYWORDS) ||
              (typeof d.priority?.importance_level === "number" && d.priority.importance_level <= 2);
            const transportMode = resolveTransportMode(d);
            const lineGroup = resolveLineGroup(transportMode, getLineNumbers(d));

            return { deviation: d, enSummary, svOriginal, isCritical, transportMode, lineGroup };
          })
        );

        const critical = prepared.filter((item) => item.isCritical);
        const nonCritical = prepared.filter((item) => !item.isCritical);

        const text = buildGroupedMessage(critical, nonCritical);
        await sendTelegramMessage({
          token: BOT_TOKEN,
          chatId: CHAT_ID,
          text,
        });

        for (const item of prepared) {
          const key = `${item.deviation.deviation_case_id}:${item.deviation.version}`;
          store.markSent(key);
        }
      } catch (error) {
        console.error("Grouped formatting failed, falling back to per-deviation sending:", error);
        for (const d of newDeviations) {
          const text = await formatDeviation(d, PREFERRED_LANG);
          await sendTelegramMessage({
            token: BOT_TOKEN,
            chatId: CHAT_ID,
            text,
          });

          const key = `${d.deviation_case_id}:${d.version}`;
          store.markSent(key);
        }
      }
    }

    tick += 1;
    if (tick % 60 === 0) store.prune(PRUNE_DAYS);
  } catch (err: any) {
    console.error("checkAndNotify error:", err?.message ?? err);
  }
}

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/check", async (_req, res) => {
  if (isRunning) {
    res.json({ ok: true, skipped: true });
    return;
  }
  isRunning = true;
  try {
    await checkAndNotify();
    res.json({ ok: true, ran: true });
  } finally {
    isRunning = false;
  }
});
app.get("/", (_req, res) => res.send("SL Green line Telegram notifier (near real-time) is running."));

app.listen(PORT, () => console.log(`Server up on :${PORT}`));
