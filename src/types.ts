export type Deviation = {
  deviation_case_id: number;
  version: number;
  created: string;
  modified: string;
  transport_mode?: string;
  publish?: { from?: string; upto?: string };
  message_variants: Array<{
    header: string; details: string; scope_alias?: string; weblink?: string; language: string;
  }>;
  scope?: {
    lines?: Array<{
      id: number; designation?: string; name?: string; group_of_lines?: string; transport_mode?: string;
    }>;
    stop_areas?: Array<{ id: number; name?: string }>;
  };
  priority?: { importance_level?: number; influence_level?: number; urgency_level?: number };
};
