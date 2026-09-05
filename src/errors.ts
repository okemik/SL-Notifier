export class TelegramDeliveryError extends Error {
  constructor(public readonly status?: number, public readonly retryAfterMs?: number) {
    super("Telegram delivery failed");
    this.name = "TelegramDeliveryError";
  }
}
export class SLResponseError extends Error {
  constructor() { super("Invalid SL response"); this.name = "SLResponseError"; }
}
/** Do not serialize unknown messages, request configs, URLs or response bodies. */
export function safeError(error: unknown): string {
  if (error instanceof TelegramDeliveryError) {
    return error.status ? `Telegram HTTP ${error.status}` : "Telegram request failed";
  }
  if (error instanceof SLResponseError) return "Invalid SL response";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const allowed = ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "ERR_CANCELED",
    "SQLITE_BUSY", "SQLITE_FULL", "SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CORRUPT"];
  return typeof code === "string" && allowed.includes(code) ? code : "Operation failed";
}
