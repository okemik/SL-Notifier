import axios from "axios";
import { SLResponseError } from "./errors.js";
import type { Deviation } from "./types.js";

const SL_DEVIATIONS_URL = "https://deviations.integration.sl.se/v1/messages";
export type SLFilters = { transportMode: string; lines: number[]; future: boolean; signal?: AbortSignal };
export type DeviationResult = { deviations: Deviation[]; rejectedCount: number };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const modes = ["BUS", "METRO", "TRAM", "TRAIN", "SHIP", "FERRY", "TAXI"];
function isDeviation(value: unknown): value is Deviation {
  if (!object(value) || !integer(value.deviation_case_id) || !integer(value.version)) return false;
  if (!Array.isArray(value.message_variants) || !value.message_variants.length) return false;
  if (!value.message_variants.every(v => object(v) && typeof v.header === "string" && typeof v.details === "string"
    && (v.header.trim().length > 0 || v.details.trim().length > 0)
    && typeof v.language === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(v.language)
    && optionalString(v.scope_alias) && optionalString(v.weblink))) return false;
  if (!optionalString(value.created) || !optionalString(value.modified)) return false;
  if (value.transport_mode !== undefined && !modes.includes(value.transport_mode as string)) return false;
  if (value.publish !== undefined && (!object(value.publish)
    || !optionalString(value.publish.from) || !optionalString(value.publish.upto))) return false;
  if (value.priority !== undefined && (!object(value.priority)
    || ["importance_level", "influence_level", "urgency_level"].some(key =>
      value.priority !== undefined && object(value.priority) && value.priority[key] !== undefined
      && (typeof value.priority[key] !== "number" || !Number.isFinite(value.priority[key]))))) return false;
  if (value.scope !== undefined) {
    if (!object(value.scope)) return false;
    if (value.scope.lines !== undefined && (!Array.isArray(value.scope.lines)
      || !value.scope.lines.every(line => object(line) && integer(line.id)
        && optionalString(line.designation) && optionalString(line.name) && optionalString(line.group_of_lines)
        && (line.transport_mode === undefined || modes.includes(line.transport_mode as string))))) return false;
    if (value.scope.stop_areas !== undefined && (!Array.isArray(value.scope.stop_areas)
      || !value.scope.stop_areas.every(stop => object(stop) && integer(stop.id) && optionalString(stop.name)))) return false;
  }
  return true;
}
export function parseDeviationResult(payload: unknown): DeviationResult {
  if (!Array.isArray(payload)) throw new SLResponseError();
  const deviations = payload.filter(isDeviation).map(d => ({
    ...d, created: d.created ?? "", modified: d.modified ?? "",
  }));
  const rejectedCount = payload.length - deviations.length;
  if (payload.length && !deviations.length) throw new SLResponseError();
  return { deviations, rejectedCount };
}
export async function fetchDeviationResult(filters: SLFilters): Promise<DeviationResult> {
  const params = new URLSearchParams({ future: String(filters.future), transport_mode: filters.transportMode });
  for (const line of filters.lines) params.append("line", String(line));
  const response = await axios.get<unknown>(`${SL_DEVIATIONS_URL}?${params}`, {
    timeout: 15000, signal: filters.signal, headers: { "User-Agent": "sl-telegram-notifier/1.2" },
  });
  return parseDeviationResult(response.data);
}
export async function fetchDeviations(filters: SLFilters): Promise<Deviation[]> {
  return (await fetchDeviationResult(filters)).deviations;
}
