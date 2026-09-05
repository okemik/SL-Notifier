import type { Deviation } from "./types.js";
import { safeError } from "./errors.js";
import { translateSvToEn } from "./translate.js";
export type FormatOptions = {
  preferredLang: string; transportMode: string; timeZone: string; translate?: boolean; signal?: AbortSignal;
  translator?: (text: string, options?: { signal?: AbortSignal }) => Promise<string>;
  log?: (message: string) => void;
};
export type PreparedDeviation = { key: string; group: string; importance: number; text: string };
const fullText = (variant: Deviation["message_variants"][number]) => [variant.header, variant.details].filter(Boolean).join("\n");
const language = (value: string) => value.toLowerCase();
export function pickVariant(d: Deviation, preferredLang = "sv") {
  return d.message_variants.find(v => language(v.language) === language(preferredLang))
    ?? d.message_variants.find(v => language(v.language) === "sv") ?? d.message_variants[0];
}
function scopeGroup(d: Deviation, fallbackMode: string): string {
  const groups = new Map<string, Set<string>>();
  for (const line of d.scope?.lines ?? []) {
    const mode = line.transport_mode ?? d.transport_mode ?? fallbackMode;
    if (!groups.has(mode)) groups.set(mode, new Set());
    groups.get(mode)!.add(line.designation || String(line.id));
  }
  if (!groups.size) groups.set(d.transport_mode ?? fallbackMode, new Set());
  const icons: Record<string, string> = { METRO: "🚇", TRAIN: "🚆", BUS: "🚌", TRAM: "🚊", SHIP: "⛴️", FERRY: "⛴️", TAXI: "🚕" };
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([mode, lineSet]) => {
    const lines = [...lineSet].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    return `${icons[mode] ?? "🚏"} ${mode}${lines.length ? ` – ${lines.length === 1 ? "Line" : "Lines"} ${lines.join(", ")}` : ""}`;
  }).join(" / ");
}
function formattedDate(value: string, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(date);
}
export async function prepareDeviation(d: Deviation, options: FormatOptions): Promise<PreparedDeviation> {
  const original = pickVariant(d, options.preferredLang);
  if (!original) throw new Error("Missing message variant");
  const originalText = fullText(original);
  const originalLang = language(original.language);
  const english = d.message_variants.find(v => language(v.language) === "en");
  const swedish = d.message_variants.find(v => language(v.language) === "sv");
  const blocks: string[] = [];
  if (originalLang === "en") {
    blocks.push(`🇬🇧 Message (EN):\n${originalText}`);
    if (swedish) blocks.push(`🇸🇪 Original (SV):\n${fullText(swedish)}`);
  } else {
    if (english) blocks.push(`🇬🇧 Summary (EN):\n${fullText(english)}`);
    else if (originalLang === "sv" && options.translate !== false) {
      try {
        const translated = await (options.translator ?? translateSvToEn)(originalText, { signal: options.signal });
        blocks.push(`🇬🇧 Translation (EN):\n${translated}`);
      } catch (cause) {
        options.log?.(`Translation failed: ${safeError(cause)}`);
        blocks.push("English translation unavailable; original message follows.");
      }
    }
    blocks.push(`${originalLang === "sv" ? "🇸🇪" : "🌐"} Original (${originalLang.toUpperCase()}):\n${originalText}`);
  }
  if (original.scope_alias) blocks.push(`Area: ${original.scope_alias}`);
  else if (d.scope?.stop_areas?.length) blocks.push(`Stops: ${d.scope.stop_areas.map(stop => stop.name ?? stop.id).join(", ")}`);
  if (d.publish?.upto) {
    const until = formattedDate(d.publish.upto, options.timeZone);
    if (until) blocks.push(`Valid until: ${until} (${options.timeZone})`);
  }
  if (original.weblink) {
    try {
      const link = new URL(original.weblink);
      if (link.protocol === "https:" || link.protocol === "http:") blocks.push(`More: ${link.href}`);
    } catch { /* Invalid optional links are omitted. */ }
  }
  const key = `${d.deviation_case_id}:${d.version}`;
  blocks.push(`ID: ${d.deviation_case_id} v${d.version}`);
  return {
    key, group: scopeGroup(d, options.transportMode),
    importance: d.priority?.importance_level ?? Number.MAX_SAFE_INTEGER, text: blocks.join("\n\n"),
  };
}
/** Use UTF-16 length conservatively; never cut a surrogate pair. */
export function splitMessage(text: string, limit = 4096): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("Invalid message limit");
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let end = limit;
    const code = remaining.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    const newline = remaining.lastIndexOf("\n", end - 1);
    if (newline > end / 2) end = newline + 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  // Telegram rejects whitespace-only messages; omit empty continuation segments.
  return parts.filter(part => part.trim().length > 0);
}
export function buildMessageBatches(items: PreparedDeviation[]): Array<{ keys: string[]; parts: string[] }> {
  const batches: Array<{ keys: string[]; parts: string[] }> = [];
  const groups = new Map<string, PreparedDeviation[]>();
  for (const item of [...items].sort((a, b) => a.importance - b.importance)) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group)!.push(item);
  }
  for (const [group, entries] of groups) {
    const header = `🚨 SL ALERTS\n${group}\n\n`;
    let text = header;
    let keys: string[] = [];
    const flush = () => {
      if (keys.length) batches.push({ keys, parts: [text] });
      keys = []; text = header;
    };
    for (const entry of entries) {
      const single = header + entry.text;
      if (single.length > 4096) {
        flush();
        batches.push({ keys: [entry.key], parts: splitMessage(single) });
        continue;
      }
      const separator = keys.length ? "\n\n──────────\n\n" : "";
      if (text.length + separator.length + entry.text.length > 4096) flush();
      text += (keys.length ? "\n\n──────────\n\n" : "") + entry.text;
      keys.push(entry.key);
    }
    flush();
  }
  return batches;
}
export async function formatDeviation(d: Deviation, preferredLang = "sv") {
  const prepared = await prepareDeviation(d, { preferredLang, transportMode: "METRO", timeZone: "Europe/Stockholm" });
  return `${prepared.group}\n\n${prepared.text}`;
}
