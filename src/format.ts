import type { Deviation } from "./types.js";

export function pickVariant(d: Deviation, preferredLang = "sv") {
  return d.message_variants.find((v) => v.language === preferredLang) ?? d.message_variants[0];
}

export function formatDeviation(d: Deviation, preferredLang = "sv") {
  const v = pickVariant(d, preferredLang);

  const scope =
    v?.scope_alias ??
    d.scope?.lines?.map((l) => l.group_of_lines ?? l.name ?? l.designation ?? String(l.id)).join(", ") ??
    "Tunnelbana";

  const publishUpto = d.publish?.upto ? `\nGäller till: ${d.publish.upto}` : "";
  const link = v?.weblink ? `\nLink: ${v.weblink}` : "";

  const header = v?.header ?? "Störning";
  const details = v?.details ?? "";

  return `🚇 SL Aksaklık (Green line)\n${scope}\n\n🧾 ${header}\n${details}${publishUpto}${link}\n\nID: ${d.deviation_case_id} v${d.version}`;
}
