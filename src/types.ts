export type Deviation = {
  deviation_case_id: number;
  version: number;
  created: string;
  modified: string;
  transport_mode?: string;
  publish?: { from?: string; upto?: string };
  message_variants: Array<{
    header: string;
    details: string;
    scope_alias?: string;
    weblink?: string;
    language: string; // "sv", "en", ...
  }>;
  scope?: {
    lines?: Array<{
      id: number;
      designation?: string;
      name?: string;
      group_of_lines?: string;
    }>;
    stop_areas?: Array<{ id: number; name?: string }>;
  };
  priority?: {
    importance_level?: number;
    impact_level?: number;
  };
};
