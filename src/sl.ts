import axios from "axios";
import type { Deviation } from "./types.js";

const SL_DEVIATIONS_URL = "https://deviations.integration.sl.se/v1/messages";

export type SLFilters = {
  transportMode: string; // METRO
  lines: number[];       // 17,18,19 etc
  future: boolean;       // include future deviations
};

export async function fetchDeviations(filters: SLFilters): Promise<Deviation[]> {
  const params = new URLSearchParams();
  params.set("future", String(filters.future));

  params.append("transport_mode", filters.transportMode);
  for (const line of filters.lines) params.append("line", String(line));

  const url = `${SL_DEVIATIONS_URL}?${params.toString()}`;

  const res = await axios.get<Deviation[]>(url, {
    timeout: 15_000,
    headers: { "User-Agent": "sl-greenline-telegram-notifier/1.1" },
  });

  return Array.isArray(res.data) ? res.data : [];
}
