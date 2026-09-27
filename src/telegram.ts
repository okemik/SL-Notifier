import axios from "axios";
import { setTimeout as delay } from "node:timers/promises";
import { TelegramDeliveryError } from "./errors.js";
export { TelegramDeliveryError } from "./errors.js";

export type TelegramOptions = {
  token: string; chatId: string; text: string; signal?: AbortSignal; replyToMessageId?: number;
};
type TelegramResponse = { ok?: unknown; result?: { message_id?: unknown }; error_code?: unknown; parameters?: { retry_after?: unknown } };
type SenderDependencies = {
  request?: (options: TelegramOptions) => Promise<TelegramResponse>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
function deliveryError(data: TelegramResponse | undefined, status?: number) {
  const code = typeof data?.error_code === "number" ? data.error_code : status;
  const retry = data?.parameters?.retry_after;
  return new TelegramDeliveryError(
    Number.isInteger(code) && code! >= 100 && code! <= 599 ? code : undefined,
    typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
  );
}
async function request(options: TelegramOptions): Promise<TelegramResponse> {
  try {
    const response = await axios.post<TelegramResponse>(
      `https://api.telegram.org/bot${options.token}/sendMessage`,
      {
        chat_id: options.chatId, text: options.text, link_preview_options: { is_disabled: true },
        ...(options.replyToMessageId ? {
          reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true },
        } : {}),
      },
      { timeout: 15000, signal: options.signal, maxRedirects: 0 },
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) throw deliveryError(error.response?.data, error.response?.status);
    throw new TelegramDeliveryError();
  }
}
export function createTelegramSender(deps: SenderDependencies = {}) {
  const send = deps.request ?? request;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let nextSendAt = 0;
  let tail: Promise<void> = Promise.resolve();
  const perform = async (options: TelegramOptions) => {
    if (!options.text.trim() || options.text.length > 4096) throw new TelegramDeliveryError(400);
    let waited = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (options.signal?.aborted) throw new TelegramDeliveryError();
      const gap = Math.max(0, nextSendAt - now());
      if (gap) await sleep(gap, options.signal);
      // Groups allow at most 20 messages per minute, including split alert parts.
      nextSendAt = now() + 3000;
      try {
        const response = await send(options);
        if (response?.ok !== true || !Number.isSafeInteger(response.result?.message_id)) {
          throw deliveryError(response);
        }
        return;
      } catch (error) {
        const safe = error instanceof TelegramDeliveryError ? error : new TelegramDeliveryError();
        const retryable = safe.status === 429 || (safe.status !== undefined && safe.status >= 500);
        if (!retryable || attempt === 2 || options.signal?.aborted) throw safe;
        const waitMs = safe.status === 429 ? Math.max(1000, safe.retryAfterMs ?? 1000) : 1000 * 2 ** attempt;
        if (waited + waitMs > 30000) throw safe;
        waited += waitMs;
        await sleep(waitMs, options.signal);
      }
    }
  };
  return (options: TelegramOptions): Promise<void> => {
    const next = tail.then(() => perform(options));
    tail = next.catch(() => {});
    return next;
  };
}
export const sendTelegramMessage = createTelegramSender();

export type TelegramChat = { id: number; type?: string; username?: string };
export type TelegramMessage = { message_id: number; date: number; text?: string; chat: TelegramChat };
export type TelegramUpdate = { update_id: number; message?: TelegramMessage };
export type BotCommand = { command: string; description: string };
export type TelegramApi = {
  getMe: (signal?: AbortSignal) => Promise<{ username?: string }>;
  getUpdates: (offset: number | undefined, signal?: AbortSignal) => Promise<TelegramUpdate[]>;
  setMyCommands: (commands: BotCommand[], signal?: AbortSignal) => Promise<void>;
};
const objectValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Keeps only well-formed text messages; anything else becomes an update without a message. */
export function parseUpdates(result: unknown): TelegramUpdate[] {
  if (!Array.isArray(result)) throw new TelegramDeliveryError();
  return result.filter(item => objectValue(item) && Number.isSafeInteger(item.update_id)).map(item => {
    const update = item as Record<string, unknown>;
    const message = update.message;
    const valid = objectValue(message) && Number.isSafeInteger(message.message_id) && Number.isFinite(message.date)
      && objectValue(message.chat) && Number.isSafeInteger(message.chat.id)
      && (message.text === undefined || typeof message.text === "string")
      && (message.chat.username === undefined || typeof message.chat.username === "string");
    return { update_id: update.update_id as number, ...(valid ? { message: message as TelegramMessage } : {}) };
  });
}
/** Bot API calls used for commands. Errors never include the token-bearing URL. */
export function createTelegramApi(token: string): TelegramApi {
  const call = async (method: string, body: object, signal?: AbortSignal, timeout = 15000): Promise<unknown> => {
    try {
      const response = await axios.post<TelegramResponse & { result?: unknown }>(
        `https://api.telegram.org/bot${token}/${method}`, body, { timeout, signal, maxRedirects: 0 },
      );
      if (response.data?.ok !== true) throw deliveryError(response.data);
      return response.data.result;
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      if (axios.isAxiosError(error)) throw deliveryError(error.response?.data, error.response?.status);
      throw new TelegramDeliveryError();
    }
  };
  return {
    getMe: async signal => {
      const result = await call("getMe", {}, signal);
      return objectValue(result) && typeof result.username === "string" ? { username: result.username } : {};
    },
    // Long polling: Telegram holds the request for up to 25 s when there are no updates.
    getUpdates: async (offset, signal) => parseUpdates(await call(
      "getUpdates", { ...(offset !== undefined ? { offset } : {}), timeout: 25, allowed_updates: ["message"] }, signal, 35000,
    )),
    setMyCommands: async (commands, signal) => { await call("setMyCommands", { commands }, signal); },
  };
}
