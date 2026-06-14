export interface Invitation {
  id: string;
  email: string;
  role: string;
  inviter_name: string;
  expires_at: string;
  created_at: string;
  invited_by?: string;
}

export interface VerifyInviteTokenResponse {
  valid: boolean;
  org_name: string;
  role: string;
  inviter_name: string;
  expires_at: string;
  email: string;
}

export interface SignupFromInviteResponse {
  user_id: string;
  email: string;
  org_id: string;
  role: string;
  message: string;
}

export interface OrgApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_by: string;
  last_used_at: string | null;
  created_at: string;
}

export interface CreateApiKeyResponse {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  raw_key: string;  // Only returned once on creation
  created_at: string | null;
}

export interface User {
  user_id: string;
  email: string;
  name: string;
  organizations?: Organization[];
  current_org_id?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  is_owner?: boolean;
  member_count?: number;
  archived_at?: string | null;
}

export interface CodeReference {
  id: string;
  name: string;
  description?: string | null;
  purpose: string;
  filename: string;
  language: string;
  content?: string;
  uploaded_by: string;
  created_at: string;
  similarity?: number;
}

export interface JobStatus {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
  stage_history: StageHistoryEntry[];
}

export interface StageHistoryEntry {
  from?: string;
  to: string;
  at: string;
}

export interface JobResult {
  job_id: string;
  status: string;
  outcome_tier: string | null;
  environment_code: string | null;
  test_results: Record<string, unknown> | null;
  quality_report: Record<string, unknown> | null;
  archivist_summary: Record<string, unknown> | null;
}

export interface JobListItem {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobListResponse {
  jobs: JobListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface JobRequest {
  description: string;
  tags: string[];
  framework: string;
  framework_version: string;
  difficulty_parameters: Record<string, unknown>;
  output_mode: string;
}

export const PIPELINE_STAGES = [
  "planning",
  "criticizing",
  "refining",
  "fact_checking",
  "executing",
  "code_quality",
  "verifying",
  "testing",
  "archiving",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<string, string> = {
  planning: "Planning",
  criticizing: "Criticizing",
  refining: "Refining",
  fact_checking: "Fact Checking",
  executing: "Executing",
  code_quality: "Code Quality",
  verifying: "Verifying",
  testing: "Testing",
  archiving: "Archiving",
  completed: "Completed",
  failed: "Failed",
  human_review: "Human Review",
  cancelled: "Cancelled",
};

export const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  running: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  human_review: "bg-orange-100 text-orange-800",
  cancelled: "bg-gray-100 text-gray-800",
};

export const OUTCOME_COLORS: Record<string, string> = {
  gold: "bg-yellow-100 text-yellow-800 border-yellow-300",
  silver: "bg-gray-100 text-gray-700 border-gray-300",
  bronze: "bg-orange-100 text-orange-700 border-orange-300",
  partial: "bg-blue-100 text-blue-700 border-blue-300",
  failed: "bg-red-100 text-red-700 border-red-300",
};

export interface OrgAnalytics {
  job_counts_by_day: Array<{ date: string; count: number }>;
  reference_uploads_by_day: Array<{ date: string; count: number }>;
  active_members_count: number;
  total_references: number;
  storage_bytes_used: number;
  member_activity: Array<{
    user_id: string;
    email: string;
    name: string;
    role: string;
    joined_at: string | null;
    last_active_at: string | null;
  }>;
}

export interface AuditEvent {
  id: string;
  org_id: string;
  user_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  user_email?: string;
  user_name?: string;
}
// ── Agent PR-suggestion types (v1.7) ─────────────────────────────

export type PRSuggestionTrigger =
  | "rca_cluster"
  | "drift_alert"
  | "retrieval_gap"
  | "judge_regression";

export type PRSuggestionStatus =
  | "pending"
  | "opened"
  | "merged"
  | "rejected";

export interface PRSuggestionFile {
  path: string;
  size: number;
}

export interface PRSuggestion {
  id: string;
  org_id: string;
  trigger: PRSuggestionTrigger;
  trigger_id: string;
  trigger_summary: string;
  files: PRSuggestionFile[];
  patch_diff: string;
  pr_title: string;
  pr_body: string;
  blast_radius: number;
  confidence: number;
  status: PRSuggestionStatus;
  created_at: string;
  opened_pr_number: number | null;
}

export interface PRSuggestionListResponse {
  status: string;
  data: {
    suggestions: PRSuggestion[];
    count: number;
    filter: {
      status: string | null;
      trigger: string | null;
      limit: number;
    };
  };
}

export interface PRSuggestionDetailResponse {
  status: string;
  data: {
    suggestion: PRSuggestion;
  };
}

export interface PRSuggestionCreateResponse {
  status: string;
  data: {
    suggestion: PRSuggestion;
    suggestion_id: string;
  };
}

export interface PRSuggestionOpenPRResponse {
  status: string;
  data: {
    suggestion_id: string;
    pr: {
      number: number;
      title: string;
      branch: string;
      base: string;
      url: string;
      state: string;
      created_at: string;
    };
  };
}

// ── Visual Builder (§8.1) ─────────────────────────────────────────
// Block kinds, handle ids, and data shapes for the React Flow
// DAG editor at /builder. Re-exported from
// clients/portal/src/app/(portal)/builder/_lib/types.ts so both
// the page and any cross-package consumer can use them.

export type BlockKind =
  | "agent"
  | "tool"
  | "scenario"
  | "scoring"
  | "memory"
  | "loop"
  | "seed";

export type HandleId =
  | "out:agent"
  | "out:tool"
  | "out:scenario"
  | "out:scoring"
  | "out:memory"
  | "out:loop"
  | "in:agent"
  | "in:tool"
  | "in:scenario"
  | "in:scoring"
  | "in:memory"
  | "in:loop";

export interface BaseBlockData {
  kind: BlockKind;
  label: string;
}

export interface AgentBlockData extends BaseBlockData {
  kind: "agent";
  name: string;
  framework: "langchain" | "openai-agents" | "raw" | "none";
}

export interface ToolBlockData extends BaseBlockData {
  kind: "tool";
  name: string;
  toolKind: "shell" | "file" | "http" | "custom";
  config: Record<string, string>;
}

export interface ScenarioBlockData extends BaseBlockData {
  kind: "scenario";
  id: string;
  envClassName: string;
  maxEpisodes: number;
  description: string;
}

export interface CriterionData {
  name: string;
  kind: "quality" | "adversarial" | "behavioural";
  weight: number;
}

export interface ScoringBlockData extends BaseBlockData {
  kind: "scoring";
  criteria: CriterionData[];
}

export interface MemoryBlockData extends BaseBlockData {
  kind: "memory";
  memoryType: "none" | "short-term" | "long-term";
  capacity: number;
}

export interface LoopBlockData extends BaseBlockData {
  kind: "loop";
  loopType: "none" | "retry" | "reflexion";
  maxIterations: number;
}

export interface SeedBlockData extends BaseBlockData {
  kind: "seed";
  value: number;
}

export type BlockData =
  | AgentBlockData
  | ToolBlockData
  | ScenarioBlockData
  | ScoringBlockData
  | MemoryBlockData
  | LoopBlockData
  | SeedBlockData;

/** Edges carry a kind for data-flow vs control-flow styling. */
export interface EdenEdgeData {
  kind: "data" | "control";
}

export interface SpecBundle {
  /** eden-sim-eval.yaml as a string. */
  yaml: string;
  /** Extra files to include in the tarball. */
  files: { path: string; body: string }[];
}

export interface SpecValidationError {
  code: string;
  message: string;
  nodeId?: string;
}

export interface SavedGraph {
  graphName: string;
  nodes: unknown[]; // EdenNode[] at runtime; looser here to avoid the React Flow type dependency in this file.
  edges: unknown[]; // EdenEdge[] at runtime.
  updatedAt: number;
}

export interface SavedGraphMeta {
  graphName: string;
  updatedAt: number;
  summary: {
    agents: number;
    tools: number;
    scenarios: number;
    seed?: number;
  };
}
