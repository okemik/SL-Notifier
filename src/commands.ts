import { setTimeout as delay } from "node:timers/promises";
import { safeError, TelegramDeliveryError } from "./errors.js";
import { pickVariant, scopeGroup, splitMessage } from "./format.js";
import type { CheckOptions, CheckResult, DeviationSnapshot, NotifierStatus } from "./notifier.js";
import type { BotCommand, TelegramApi, TelegramChat, TelegramUpdate } from "./telegram.js";
import type { Deviation } from "./types.js";

export type CommandName = "status" | "lines" | "check" | "help";
const aliases: Record<string, CommandName> = {
  status: "status", durum: "status",
  lines: "lines", hatlar: "lines",
  check: "check", kontrol: "check",
  help: "help", yardim: "help", start: "help",
};
export const BOT_COMMANDS: BotCommand[] = [
  { command: "status", description: "Active deviations on monitored lines" },
  { command: "lines", description: "Monitored lines and settings" },
  { command: "check", description: "Check SL now" },
  { command: "help", description: "List commands" },
];

/** Returns the command for this bot, or null for plain text and commands addressed to other bots. */
export function parseCommand(text: string | undefined, botUsername?: string): CommandName | null {
  const match = /^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text?.trim() ?? "");
  if (!match) return null;
  if (match[2] && match[2].toLowerCase() !== botUsername?.toLowerCase()) return null;
  return aliases[match[1].toLowerCase()] ?? null;
}

/** Only the configured destination chat may use commands (numeric ID or @channel/@group username). */
export function isAuthorizedChat(chat: TelegramChat, chatId: string): boolean {
  const expected = chatId.trim();
  if (String(chat.id) === expected) return true;
  return expected.startsWith("@") && chat.username !== undefined
    && `@${chat.username}`.toLowerCase() === expected.toLowerCase();
}

export type CommandContext = {
  notifier: {
    check: (options?: CheckOptions) => Promise<CheckResult>;
    status: () => NotifierStatus;
    activeDeviations: () => DeviationSnapshot | null;
  };
  transportMode: string; lines: number[]; future: boolean; intervalMs: number; timeZone: string; preferredLang: string;
  now?: () => number;
};

const icons: Record<string, string> = { METRO: "🚇", TRAIN: "🚆", BUS: "🚌", TRAM: "🚊", SHIP: "⛴️", FERRY: "⛴️", TAXI: "🚕" };
const time = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
const monitored = (ctx: CommandContext) =>
  `${icons[ctx.transportMode] ?? "🚏"} ${ctx.transportMode} ${ctx.lines.length === 1 ? "line" : "lines"} ${ctx.lines.join(", ")}`;

function headline(d: Deviation, preferredLang: string): string {
  const variant = d.message_variants.find(v => v.language.toLowerCase() === "en") ?? pickVariant(d, preferredLang);
  const text = (variant?.header.trim() || variant?.details.trim().split("\n")[0] || "Deviation").replace(/\s+/g, " ");
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function statusText(ctx: CommandContext): string {
  const status = ctx.notifier.status();
  const snapshot = ctx.notifier.activeDeviations();
  const blocks = [`📊 SL status – ${monitored(ctx)}`];
  if (!snapshot) {
    blocks.push("No successful SL check yet.");
  } else {
    const unique = new Map(snapshot.deviations.map(d => [`${d.deviation_case_id}:${d.version}`, d]));
    const deviations = [...unique.values()].sort((a, b) =>
      (a.priority?.importance_level ?? Number.MAX_SAFE_INTEGER) - (b.priority?.importance_level ?? Number.MAX_SAFE_INTEGER));
    blocks.push(deviations.length
      ? [`⚠️ ${deviations.length} active ${deviations.length === 1 ? "deviation" : "deviations"}:`,
        ...deviations.map(d => `• ${scopeGroup(d, ctx.transportMode)}: ${headline(d, ctx.preferredLang)}`)].join("\n")
      : "✅ No active deviations.");
    blocks.push(`Data from: ${time(snapshot.fetchedAt, ctx.timeZone)}`);
  }
  if (status.lastError && !status.ready) blocks.push(`⚠️ Last check had problems: ${status.lastError}`);
  if (status.pendingBatches) blocks.push(`📨 ${status.pendingBatches} alert message(s) waiting for delivery.`);
  if (status.failedBatches) blocks.push(`❌ ${status.failedBatches} alert message(s) were rejected by Telegram.`);
  return blocks.join("\n\n");
}

function linesText(ctx: CommandContext): string {
  const seconds = Math.round(ctx.intervalMs / 1000);
  return [
    `Monitoring ${monitored(ctx)}`,
    `Checks every ${seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`} · future deviations: ${ctx.future ? "on" : "off"}`,
  ].join("\n");
}

function checkText(result: CheckResult, now: number): string {
  if (result.skipped === "interval") {
    const wait = result.nextCheckAt ? Math.max(1, Math.ceil((Date.parse(result.nextCheckAt) - now) / 1000)) : undefined;
    return `⏳ SL was checked moments ago.${wait ? ` Try again in ${wait} s.` : ""}`;
  }
  if (result.skipped === "running") return "⏳ A check is already running.";
  if (result.skipped === "stopping") return "The service is shutting down.";
  const summary = `${result.fetched ?? 0} active, ${result.queued ?? 0} new, ${result.sent ?? 0} delivered`;
  return result.ok ? `✅ Check completed: ${summary}.` : `⚠️ Check finished with problems (${summary}): ${result.error ?? "unknown error"}`;
}

export const HELP_TEXT = [
  "SL notifier commands",
  "/status (/durum) – active deviations on monitored lines",
  "/lines (/hatlar) – monitored lines and settings",
  "/check (/kontrol) – check SL now",
  "/help (/yardim) – this list",
].join("\n");

/** Builds the reply for a command; long replies are split to Telegram's limit. */
export async function respond(command: CommandName, ctx: CommandContext): Promise<string[]> {
  switch (command) {
    case "status": return splitMessage(statusText(ctx));
    case "lines": return [linesText(ctx)];
    case "check": {
      const result = await ctx.notifier.check({ source: "manual" });
      return [checkText(result, (ctx.now ?? Date.now)())];
    }
    case "help": return [HELP_TEXT];
  }
}

export type CommandPollerDependencies = {
  api: TelegramApi;
  chatId: string;
  handle: (command: CommandName) => Promise<string[]>;
  reply: (text: string, replyToMessageId: number) => Promise<void>;
  store: { getMeta: (key: string) => string | undefined; setMeta: (key: string, value: string) => void };
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
};
const OFFSET_KEY = "telegram_update_offset";
/** Commands older than this (e.g. sent while the service was down) are ignored. */
export const MAX_COMMAND_AGE_MS = 120000;

/** Receives bot commands with getUpdates long polling, so no public URL or webhook is needed. */
export class CommandPoller {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private username?: string;
  private readonly warnedChats = new Set<string>();

  constructor(private readonly deps: CommandPollerDependencies) {
    this.signal = deps.signal ? AbortSignal.any([deps.signal, this.controller.signal]) : this.controller.signal;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }
  start(): void {
    if (this.loop || this.stopping) return;
    this.loop = this.run().catch(cause => { this.deps.log?.(`Command polling stopped: ${safeError(cause)}`); });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await this.loop;
  }
  private get active() { return !this.stopping && !this.signal.aborted; }
  private async pause(ms: number) {
    try { await this.sleep(ms, this.signal); } catch { /* Aborted by shutdown. */ }
  }
  private async run(): Promise<void> {
    const startedAt = this.now();
    let failures = 0;
    while (this.active) {
      try {
        this.username = (await this.deps.api.getMe(this.signal)).username;
        this.deps.log?.(`Telegram commands enabled for @${this.username ?? "unknown"} in chat ${this.deps.chatId}`);
        break;
      }
      catch (cause) {
        if (!this.active) return;
        this.deps.log?.(`Telegram getMe failed: ${safeError(cause)}`);
        await this.pause(Math.min(300000, 5000 * 2 ** failures++));
      }
    }
    // The command menu is a convenience; failure to register it does not affect commands.
    if (this.active) await this.deps.api.setMyCommands(BOT_COMMANDS, this.signal)
      .catch(cause => this.deps.log?.(`Telegram setMyCommands failed: ${safeError(cause)}`));
    const stored = Number(this.deps.store.getMeta(OFFSET_KEY));
    let offset = Number.isSafeInteger(stored) && stored > 0 ? stored : undefined;
    failures = 0;
    while (this.active) {
      let updates: TelegramUpdate[];
      try { updates = await this.deps.api.getUpdates(offset, this.signal); failures = 0; }
      catch (cause) {
        if (!this.active) return;
        const conflict = cause instanceof TelegramDeliveryError && cause.status === 409;
        this.deps.log?.(conflict
          ? "Telegram getUpdates conflict (409): a webhook is set or another instance uses this bot token"
          : `Telegram getUpdates failed: ${safeError(cause)}`);
        await this.pause(conflict ? 60000 : Math.min(60000, 2000 * 2 ** failures++));
        continue;
      }
      for (const update of updates) {
        if (!this.active) return;
        // Advance before handling: a crash re-delivers nothing rather than repeating a /check.
        offset = update.update_id + 1;
        this.deps.store.setMeta(OFFSET_KEY, String(offset));
        await this.handleUpdate(update, startedAt);
      }
    }
  }
  private async handleUpdate(update: TelegramUpdate, startedAt: number): Promise<void> {
    const message = update.message;
    if (!message) return;
    const command = parseCommand(message.text, this.username);
    if (!command) return;
    if (!isAuthorizedChat(message.chat, this.deps.chatId)) {
      // Logged once per chat so a mismatched TELEGRAM_CHAT_ID is diagnosable without flooding the log.
      const id = String(message.chat.id);
      if (!this.warnedChats.has(id) && this.warnedChats.size < 100) {
        this.warnedChats.add(id);
        this.deps.log?.(`Ignoring /${command} from chat ${id}: it is not TELEGRAM_CHAT_ID`);
      }
      return;
    }
    if (message.date * 1000 < startedAt - MAX_COMMAND_AGE_MS) {
      this.deps.log?.(`Ignoring /${command} sent before the service started`);
      return;
    }
    this.deps.log?.(`Received /${command}`);
    try {
      for (const part of await this.deps.handle(command)) {
        if (!this.active) return;
        await this.deps.reply(part, message.message_id);
      }
    } catch (cause) {
      this.deps.log?.(`Command /${command} failed: ${safeError(cause)}`);
    }
  }
}
