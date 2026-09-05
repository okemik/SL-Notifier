import axios from "axios";
type TranslationDependencies = {
  request?: (text: string, signal?: AbortSignal) => Promise<string>;
  now?: () => number;
};
// Free, key-less Swedish->English chain used by the default translator:
// 1) Google's dict-chrome-ex endpoint (best quality, JSON array of strings)
// 2) MyMemory public API as fallback (500-byte UTF-8 chunks, no API key)
async function googleRequest(text: string, signal?: AbortSignal): Promise<string> {
  const res = await axios.get<unknown>("https://clients5.google.com/translate_a/t", {
    params: { client: "dict-chrome-ex", sl: "sv", tl: "en", q: text }, signal, timeout: 8000,
  });
  const data = res.data as unknown;
  if (!Array.isArray(data)) throw new Error("Invalid translation response");
  if (typeof data[0] === "string") {
    const translated = data.filter((part): part is string => typeof part === "string").join("");
    if (!translated.trim()) throw new Error("Empty translation response");
    return translated;
  }
  if (Array.isArray(data[0])) {
    const translated = data[0].map((part: unknown) =>
      Array.isArray(part) && typeof part[0] === "string" ? part[0] : "").join("");
    if (!translated.trim()) throw new Error("Empty translation response");
    return translated;
  }
  throw new Error("Invalid translation response");
}
function splitChunks(text: string): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let bytes = 0, end = 0, wordEnd = 0;
    for (const character of remaining) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > 500) break;
      if (/\s/.test(character)) wordEnd = end;
      bytes += size;
      end += character.length;
    }
    // Prefer a nearby word boundary; never split a Unicode code point.
    if (end < remaining.length && wordEnd > end / 2) end = wordEnd;
    const chunk = remaining.slice(0, end).trim();
    if (chunk) parts.push(chunk);
    remaining = remaining.slice(end).trimStart();
  }
  return parts;
}
async function myMemoryRequest(text: string, signal?: AbortSignal): Promise<string> {
  const email = process.env.TRANSLATE_EMAIL?.trim();
  const translated: string[] = [];
  for (const chunk of splitChunks(text)) {
    const res = await axios.get<{ responseData?: { translatedText?: unknown }; responseStatus?: number }>(
      "https://api.mymemory.translated.net/get",
      { params: { q: chunk, langpair: "sv|en", ...(email ? { de: email } : {}) }, signal, timeout: 8000 },
    );
    const value = res.data?.responseData?.translatedText;
    if (res.data?.responseStatus !== 200 || typeof value !== "string" || !value.trim() || /MYMEMORY WARNING/i.test(value)) {
      throw new Error("Invalid translation response");
    }
    translated.push(value.trim());
  }
  const joined = translated.join(" ").trim();
  if (!joined) throw new Error("Empty translation response");
  return joined;
}
const defaultRequest = createDefaultRequest();
export type ChainDependencies = {
  google?: (text: string, signal?: AbortSignal) => Promise<string>;
  memory?: (text: string, signal?: AbortSignal) => Promise<string>;
};
/** Chain order matters: Google first (quality), MyMemory second (quota is per-IP). */
export function createDefaultRequest(deps: ChainDependencies = {}) {
  const google = deps.google ?? googleRequest;
  const memory = deps.memory ?? myMemoryRequest;
  return async (text: string, signal?: AbortSignal): Promise<string> => {
    try { return await google(text, signal); }
    catch (cause) { if (signal?.aborted) throw cause; return await memory(text, signal); }
  };
}
export function createTranslator(deps: TranslationDependencies = {}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { value: string; expires: number }>();
  const request = deps.request ?? defaultRequest;
  return async (text: string, options: { signal?: AbortSignal } = {}): Promise<string> => {
    if (!text.trim()) return text;
    if (text.length > 4000) throw new Error("Translation input is too long");
    if (options.signal?.aborted) throw new Error("Translation cancelled");
    const cached = cache.get(text);
    if (cached && cached.expires > now()) return cached.value;
    const translated = await request(text, options.signal);
    if (!translated.trim()) throw new Error("Empty translation response");
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(text, { value: translated, expires: now() + 3600000 });
    return translated;
  };
}
export const translateSvToEn = createTranslator();
/**
 * No-key Swedish-to-English translator backed by a self-hosted LibreTranslate
 * instance (https://libretranslate.com). Run one container (no API key, free):
 *   docker run -p 5000:5000 libretranslate/libretranslate:1.11
 * Pass `request` only in tests.
 */
export type LibreTranslateTranslatorDependencies = {
  endpoint?: string;
  now?: () => number;
  request?: (text: string, signal?: AbortSignal) => Promise<string>;
};
export function createLibreTranslateTranslator(deps: LibreTranslateTranslatorDependencies = {}) {
  const now = deps.now ?? Date.now;
  const endpoint = (deps.endpoint ?? "http://localhost:5000").replace(/\/+$/, "");
  const cache = new Map<string, { value: string; expires: number }>();
  const request = deps.request ?? (async (text: string, signal?: AbortSignal) => {
    const response = await axios.post<{ translatedText?: string }>(
      endpoint + "/translate",
      { q: text, source: "sv", target: "en", format: "text" },
      { signal, timeout: 8000, headers: { "Content-Type": "application/json" } },
    );
    const translated = response.data?.translatedText;
    if (typeof translated !== "string") throw new Error("Invalid translation response");
    return translated;
  });
  return async (text: string, options: { signal?: AbortSignal } = {}): Promise<string> => {
    if (!text.trim()) return text;
    if (text.length > 4000) throw new Error("Translation input is too long");
    if (options.signal?.aborted) throw new Error("Translation cancelled");
    const cached = cache.get(text);
    if (cached && cached.expires > now()) return cached.value;
    const translated = await request(text, options.signal);
    if (!translated.trim()) throw new Error("Empty translation response");
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(text, { value: translated, expires: now() + 3600000 });
    return translated;
  };
}
