import axios from "axios";

const TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";

export async function translateSvToEn(text: string): Promise<string> {
  if (!text.trim()) return text;

  const params = new URLSearchParams({
    client: "gtx",
    sl: "sv",
    tl: "en",
    dt: "t",
    q: text,
  });

  const res = await axios.get(TRANSLATE_URL, {
    params,
    timeout: 15_000,
  });

  const data = res.data as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Unexpected translation response");
  }

  const translated = data[0]
    .map((part: unknown) => (Array.isArray(part) ? String(part[0] ?? "") : ""))
    .filter((segment) => segment.length > 0)
    .join("");

  if (!translated) {
    throw new Error("Empty translation response");
  }

  return translated;
}
