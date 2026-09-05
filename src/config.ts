export type Config = {
  botToken: string; chatId: string; intervalMs: number; transportMode: string;
  lines: number[]; future: boolean; preferredLang: string; translateEnabled: boolean;
  translateBackend: "google" | "libre"; translateEndpoint?: string;
  timeZone: string; pruneDays: number; stateDb: string; port: number; checkApiKey?: string;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  const boolean = (name: string, fallback: boolean) => {
    const value = (env[name] ?? String(fallback)).toLowerCase();
    if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
    return value === "true";
  };
  const transportMode = (env.TRANSPORT_MODE ?? "METRO").trim().toUpperCase();
  if (!["BUS", "METRO", "TRAM", "TRAIN", "SHIP", "FERRY", "TAXI"].includes(transportMode)) {
    throw new Error("TRANSPORT_MODE must be a supported SL transport mode");
  }
  const lineParts = (env.LINES ?? "17,18,19").split(",").map(part => part.trim());
  if (lineParts.some(part => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) < 1)) {
    throw new Error("LINES must contain comma-separated positive line numbers");
  }
  const timeZone = env.TZ ?? "Europe/Stockholm";
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
  catch { throw new Error("TZ must be a valid time zone"); }
  const preferredLang = (env.PREFERRED_LANG ?? "sv").trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(preferredLang)) throw new Error("PREFERRED_LANG must be a language code");
  const translateBackend = (env.TRANSLATE_BACKEND ?? "google").trim().toLowerCase();
  if (translateBackend !== "google" && translateBackend !== "libre") throw new Error("TRANSLATE_BACKEND must be 'google' or 'libre'");
  const translateEndpoint = env.TRANSLATE_ENDPOINT?.trim() || undefined;
  const stateDb = (env.STATE_DB ?? "state.db").trim();
  if (!stateDb) throw new Error("STATE_DB must not be empty");
  return {
    botToken: required("TELEGRAM_BOT_TOKEN"), chatId: required("TELEGRAM_CHAT_ID"),
    intervalMs: integer("CHECK_INTERVAL_MS", 60000, 60000, 86400000), transportMode,
    lines: [...new Set(lineParts.map(Number))], future: boolean("FUTURE", false),
    preferredLang, translateEnabled: boolean("TRANSLATE_ENABLED", true), timeZone,
    translateBackend, translateEndpoint,
    pruneDays: integer("PRUNE_DAYS", 14, 1, 3650), stateDb,
    port: integer("PORT", 3000, 1, 65535), checkApiKey: env.CHECK_API_KEY?.trim() || undefined,
  };
}
