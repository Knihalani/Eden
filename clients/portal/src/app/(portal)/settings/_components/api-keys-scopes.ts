/** Production API host — SDKs default here; no EDEN_BASE_URL needed. */
export const API_HOST = "https://api.edenobservability.com";

/** Subset of VALID_SCOPES in src/eden/api/routes/api_keys.py shown in the UI. */
export const ALL_SCOPES = [
  { id: "references:read", label: "Read References" },
  { id: "references:write", label: "Write References" },
  { id: "jobs:read", label: "Read Jobs" },
  { id: "jobs:write", label: "Submit Jobs" },
  { id: "ingest:write", label: "Ingest write" },
  { id: "gateway:write", label: "Gateway write" },
  { id: "mcp:read", label: "MCP read" },
  { id: "mcp:debug", label: "MCP debug" },
  { id: "mcp:fix", label: "MCP fix" },
  { id: "mcp:*", label: "MCP all" },
] as const;

/** Defaults for first-run SDK / gateway — includes ingest so traces land. */
export const SDK_DEFAULT_SCOPES = [
  "references:read",
  "references:write",
  "jobs:read",
  "jobs:write",
  "ingest:write",
  "gateway:write",
];

export const MCP_DEFAULT_SCOPES = ["mcp:read", "mcp:debug", "mcp:fix"];

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at?: string;
  last_used_at?: string;
}
