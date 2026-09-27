import test from "node:test";
import assert from "node:assert/strict";
import { CommandPoller, isAuthorizedChat, parseCommand, respond, type CommandContext } from "../src/commands.js";
import type { CheckResult, NotifierStatus } from "../src/notifier.js";
import { TelegramDeliveryError } from "../src/errors.js";
import type { TelegramApi, TelegramUpdate } from "../src/telegram.js";
import { deviation } from "./fixtures.js";

const status: NotifierStatus = {
  running: false, stopping: false, ready: true, lastAttemptAt: null, lastSuccessAt: null, lastError: null,
  nextCheckAt: null, consecutiveFailures: 0, pendingBatches: 0, failedBatches: 0,
};
function context(overrides: Partial<CommandContext["notifier"]> = {}): CommandContext {
  return {
    notifier: {
      check: async () => ({ ok: true, ran: true, fetched: 2, queued: 1, sent: 1 }),
      status: () => status, activeDeviations: () => null, ...overrides,
    },
    transportMode: "METRO", lines: [17, 18, 19], future: false, intervalMs: 60000,
    timeZone: "Europe/Stockholm", preferredLang: "sv", now: () => Date.parse("2026-09-27T12:00:00Z"),
  };
}

test("commands, Turkish aliases and bot mentions are parsed; other bots and plain text are ignored", () => {
  assert.equal(parseCommand("/status"), "status");
  assert.equal(parseCommand("/durum extra words"), "status");
  assert.equal(parseCommand("/Kontrol@SL_Bot", "sl_bot"), "check");
  assert.equal(parseCommand("/check@other_bot", "sl_bot"), null);
  assert.equal(parseCommand("/check@sl_bot"), null);
  assert.equal(parseCommand("/statusx"), null);
  assert.equal(parseCommand("/unknown"), null);
  assert.equal(parseCommand("status"), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand("/start"), "help");
});
test("only the configured chat is authorized", () => {
  assert.equal(isAuthorizedChat({ id: -100123 }, "-100123"), true);
  assert.equal(isAuthorizedChat({ id: 5 }, "-100123"), false);
  assert.equal(isAuthorizedChat({ id: 5, username: "SLGroup" }, "@slgroup"), true);
  assert.equal(isAuthorizedChat({ id: 5, username: "slgroup" }, "slgroup"), false);
});
test("status lists active deviations by importance and reports delivery problems", async () => {
  const urgent = { ...deviation(2, "Stopped", [18]), priority: { importance_level: 1 } };
  const ctx = context({
    activeDeviations: () => ({ deviations: [deviation(1), urgent, urgent], fetchedAt: "2026-09-27T12:00:00Z" }),
    status: () => ({ ...status, ready: false, lastError: "SL check failed: ETIMEDOUT", pendingBatches: 2, failedBatches: 1 }),
  });
  const [text] = await respond("status", ctx);
  assert.match(text, /2 active deviations/);
  assert.ok(text.indexOf("Line 18") < text.indexOf("Line 17"));
  assert.match(text, /27 Sept? 2026, 14:00/);
  assert.match(text, /ETIMEDOUT/); assert.match(text, /2 alert message/); assert.match(text, /rejected by Telegram/);
  assert.match((await respond("status", context({ activeDeviations: () => ({ deviations: [], fetchedAt: "2026-09-27T12:00:00Z" }) })))[0], /No active deviations/);
  assert.match((await respond("status", context()))[0], /No successful SL check yet/);
});
test("check, lines and help replies describe the outcome", async () => {
  let options: unknown;
  const reply = async (result: CheckResult) => (await respond("check", context({ check: async o => { options = o; return result; } })))[0];
  assert.match(await reply({ ok: true, ran: true, fetched: 2, queued: 1, sent: 1 }), /Check completed: 2 active, 1 new, 1 delivered/);
  assert.deepEqual(options, { source: "manual" });
  assert.match(await reply({ ok: false, ran: true, error: "SL check failed: ENOTFOUND" }), /problems.*ENOTFOUND/);
  assert.match(await reply({ ok: true, ran: false, skipped: "interval", nextCheckAt: "2026-09-27T12:00:07Z" }), /Try again in 7 s/);
  assert.match(await reply({ ok: true, ran: false, skipped: "running" }), /already running/);
  assert.match((await respond("lines", context()))[0], /METRO lines 17, 18, 19\nChecks every 1 min · future deviations: off/);
  assert.match((await respond("help", context()))[0], /\/kontrol/);
});

function fakeApi(batches: Array<TelegramUpdate[] | Error>, onEmpty: () => void) {
  const offsets: Array<number | undefined> = [];
  let registered = 0;
  const api: TelegramApi = {
    getMe: async () => ({ username: "sl_bot" }),
    setMyCommands: async () => { registered++; },
    getUpdates: async (offset, signal) => {
      offsets.push(offset);
      const next = batches.shift();
      if (!next) {
        onEmpty();
        return new Promise<TelegramUpdate[]>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { api, offsets, registered: () => registered };
}
const message = (update_id: number, text: string, chatId = -100, date = 1790000000) =>
  ({ update_id, message: { message_id: update_id * 10, date, text, chat: { id: chatId } } });

test("the poller answers authorized recent commands, persists its offset and survives API errors", async t => {
  const meta = new Map<string, string>([["telegram_update_offset", "40"]]);
  const replies: Array<[string, number]> = [];
  const handled: string[] = [];
  const logs: string[] = [];
  let finish!: () => void;
  const drained = new Promise<void>(resolve => { finish = resolve; });
  const fake = fakeApi([
    [message(41, "/status"), message(42, "/status", 999), message(43, "/check@other_bot"), message(44, "hello")],
    new TelegramDeliveryError(409),
    [message(45, "/durum@sl_bot"), message(46, "/help", -100, 1790000000 - 3600), { update_id: 47 }],
  ], () => finish());
  const poller = new CommandPoller({
    api: fake.api, chatId: "-100",
    handle: async command => { handled.push(command); return [`reply:${command}`]; },
    reply: async (text, id) => { replies.push([text, id]); },
    store: { getMeta: key => meta.get(key), setMeta: (key, value) => { meta.set(key, value); } },
    now: () => 1790000000 * 1000, sleep: async () => {}, log: text => logs.push(text),
  });
  t.after(() => poller.stop());
  poller.start();
  await drained;
  assert.deepEqual(handled, ["status", "status"]);
  assert.deepEqual(replies, [["reply:status", 410], ["reply:status", 450]]);
  assert.deepEqual(fake.offsets, [40, 45, 45, 48]);
  assert.equal(meta.get("telegram_update_offset"), "48");
  assert.equal(fake.registered(), 1);
  assert.ok(logs.some(line => /409/.test(line)));
  await poller.stop();
});
test("stop aborts a pending long poll", async () => {
  const poller = new CommandPoller({
    api: {
      getMe: async () => ({}), setMyCommands: async () => {},
      getUpdates: (_offset, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    },
    chatId: "1", handle: async () => [], reply: async () => {},
    store: { getMeta: () => undefined, setMeta: () => {} },
  });
  poller.start();
  await new Promise(resolve => setImmediate(resolve));
  await poller.stop();
});
