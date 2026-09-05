import type { Deviation } from "../src/types.js";
export function deviation(id = 1, details = "Minor delay", lines = [17]): Deviation {
  return {
    deviation_case_id: id, version: 1, created: "2026-09-05T10:00:00Z", modified: "2026-09-05T10:00:00Z",
    message_variants: [
      { language: "sv", header: "Information", details },
      { language: "en", header: "Information", details },
    ],
    scope: { lines: lines.map(id => ({ id, designation: String(id), transport_mode: "METRO" })) },
    priority: { importance_level: 2 },
  };
}
