import type { Deviation } from "./types.js";
import { translateSvToEn } from "./translate.js";

export function pickVariant(d: Deviation, preferredLang = "sv") {
  return d.message_variants.find((v) => v.language === preferredLang) ?? d.message_variants[0];
}

export async function formatDeviation(d: Deviation, preferredLang = "sv") {
  const v = pickVariant(d, preferredLang);

  const scope =
    v?.scope_alias ??
    d.scope?.lines?.map((l) => l.group_of_lines ?? l.name ?? l.designation ?? String(l.id)).join(", ") ??
    "Tunnelbana";

  const publishUpto = d.publish?.upto ? `\nGäller till: ${d.publish.upto}` : "";
  const link = v?.weblink ? `\nLink: ${v.weblink}` : "";

  const header = v?.header ?? "Störning";
  const details = v?.details ?? "";

  const svMessage = `${header}\n${details}${publishUpto}${link}`;
  const svSummary = `${header}\n${details}`.trim();

  try {
    const enSummary = await translateSvToEn(svSummary);

    return `🚇 SL ALERT – Green Line\n${scope}\n\n🇬🇧 Summary (EN):\n${enSummary}\n\n🇸🇪 Original message (SV):\n${svMessage}\n\nID: ${d.deviation_case_id} v${d.version}`;
  } catch (error) {
    console.warn("Translation failed, sending Swedish only:", error);
    return `🚇 SL ALERT – Green Line\n${scope}\n\n🇸🇪 Original message (SV):\n${svMessage}\n\nID: ${d.deviation_case_id} v${d.version}`;
  }
}
