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
