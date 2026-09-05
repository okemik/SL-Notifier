import axios from "axios";
type TranslationDependencies = {
  request?: (text: string, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
export function createTranslator(deps: TranslationDependencies = {}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { value: string; expires: number }>();
  const request = deps.request ?? (async (text: string, signal?: AbortSignal) => {
    const response = await axios.get<unknown>("https://translate.googleapis.com/translate_a/single", {
      params: { client: "gtx", sl: "sv", tl: "en", dt: "t", q: text }, signal, timeout: 8000,
    });
    return response.data;
  });
  return async (text: string, options: { signal?: AbortSignal } = {}): Promise<string> => {
    if (!text.trim()) return text;
    if (text.length > 4000) throw new Error("Translation input is too long");
    if (options.signal?.aborted) throw new Error("Translation cancelled");
    const cached = cache.get(text);
    if (cached && cached.expires > now()) return cached.value;
    const data = await request(text, options.signal);
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Invalid translation response");
    const translated = data[0].map((part: unknown) =>
      Array.isArray(part) && typeof part[0] === "string" ? part[0] : "").join("");
    if (!translated.trim()) throw new Error("Empty translation response");
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(text, { value: translated, expires: now() + 3600000 });
    return translated;
  };
}
export const translateSvToEn = createTranslator();

/** Decode the common HTML entities Google Cloud Translation wraps output in. */
const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

export type GoogleCloudTranslatorDependencies = {
  apiKey: string;
  now?: () => number;
  request?: (text: string, signal?: AbortSignal) => Promise<string>;
};

/**
 * Swedish-to-English translator backed by the contracted Google Cloud Translation
 * API v2 (https://cloud.google.com/translation). Pass `request` only in tests.
 * Falls back to the free endpoint behaviour elsewhere when no API key is configured.
 */
export function createGoogleCloudTranslator(deps: GoogleCloudTranslatorDependencies) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { value: string; expires: number }>();
  const request = deps.request ?? (async (text: string, signal?: AbortSignal) => {
    const response = await axios.post<{ data: { translations: Array<{ translatedText: string }> } }>(
      "https://translation.googleapis.com/language/translate/v2?key=" + encodeURIComponent(deps.apiKey),
      new URLSearchParams({ q: text, source: "sv", target: "en", format: "text" }),
      { signal, timeout: 8000, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const translated = response.data?.data?.translations?.[0]?.translatedText;
    if (typeof translated !== "string") throw new Error("Invalid translation response");
    return decodeHtmlEntities(translated);
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
