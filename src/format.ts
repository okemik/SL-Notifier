import type { Deviation } from "./types.js";
import { translateSvToEn } from "./translate.js";

export function pickVariant(d: Deviation, preferredLang = "sv") {
  return d.message_variants.find((v) => v.language === preferredLang) ?? d.message_variants[0];
}

function pickLanguageVariant(d: Deviation, lang: string) {
  return d.message_variants.find((v) => v.language === lang);
}

export async function buildDeviationSummaries(d: Deviation, preferredLang = "sv") {
  const svVariant = pickLanguageVariant(d, "sv") ?? pickVariant(d, preferredLang);
  const enVariant = pickLanguageVariant(d, "en");

  const header = svVariant?.header ?? "Störning";
  const details = svVariant?.details ?? "";

  const publishUpto = d.publish?.upto ? `\nGäller till: ${d.publish.upto}` : "";
  const link = svVariant?.weblink ? `\nLink: ${svVariant.weblink}` : "";

  const svOriginal = `${header}\n${details}${publishUpto}${link}`.trim();
  const svSummary = `${header}\n${details}`.trim();

  if (enVariant) {
    const enSummary = `${enVariant.header}\n${enVariant.details}`.trim();
    return { enSummary, svOriginal, svSummary };
  }

  try {
    const enSummary = await translateSvToEn(svSummary);
    return { enSummary, svOriginal, svSummary };
  } catch (error) {
    console.warn("Translation failed, sending Swedish summary only:", error);
    return { enSummary: svSummary, svOriginal, svSummary };
  }
}

export async function formatDeviation(d: Deviation, preferredLang = "sv") {
  const v = pickVariant(d, preferredLang);

  const scope =
    v?.scope_alias ??
    d.scope?.lines?.map((l) => l.group_of_lines ?? l.name ?? l.designation ?? String(l.id)).join(", ") ??
    "Tunnelbana";

  const { enSummary, svOriginal } = await buildDeviationSummaries(d, preferredLang);

  return `🚇 SL ALERT – Green Line\n${scope}\n\n🇬🇧 Summary (EN):\n${enSummary}\n\n🇸🇪 Original message (SV):\n${svOriginal}\n\nID: ${d.deviation_case_id} v${d.version}`;
}
