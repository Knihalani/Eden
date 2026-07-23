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
  /** Optional — populated by ``PATCH /auth/users/me`` after an
   *  avatar upload (the BE endpoint returns the URL). The Clerk
   *  primary value (``imageUrl``) is mirrored here so consumers
   *  don't need to reach into the Clerk SDK. */
  avatar_url?: string;
  organizations: Organization[];
  current_org_id: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  is_owner?: boolean;
  member_count?: number;
  archived_at?: string | null;
  /** Clerk organization id (``org_…``) when synced; used to match
   *  ``useOrganization()`` active org to the Eden row. */
  clerk_org_id?: string | null;
  /** Solo personal workspace (migration 046). Soft-hides invite/SCIM/transfer. */
  is_personal?: boolean;
  /** Backend ``organizations.features`` JSONB column. May be
   *  undefined for older ``getOrg`` responses that didn't return it. */
  settings?: Record<string, unknown>;
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

// ----- Status & Outcome visual descriptors -----
// Each entry bundles a label, an icon (lucide-react), and a Tailwind class
// string for the badge. Color is NEVER the only signal — the icon and the
// human-readable label are both rendered, so users with color-vision
// deficiencies can still distinguish states. See <StatusBadge /> and
// <OutcomeBadge /> in components/ui/status-badge.tsx for the renderer.

import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Ban,
  Clock,
  Loader2,
  Trophy,
  Medal,
  Award,
  CircleDashed,
  CircleSlash,
  GitPullRequest,
} from "lucide-react";

export interface StatusDescriptor {
  label: string;
  className: string;
  icon: LucideIcon;
}

export interface OutcomeDescriptor {
  label: string;
  className: string;
  icon: LucideIcon;
}

export const STATUS_COLORS: Record<string, string> = {
  pending: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  // running now uses --status-running (sky) instead of --accent
  // (CTA blue) so a "Running" pill no longer looks like a button.
  running: "bg-[var(--status-running-bg)] text-[var(--status-running)]",
  completed: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  failed: "bg-[var(--error-muted)] text-[var(--error)]",
  human_review: "bg-[var(--error-muted)] text-[var(--error)]",
  cancelled: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
};

export const STATUS: Record<string, StatusDescriptor> = {
  pending: { label: "Pending",        className: STATUS_COLORS.pending,      icon: Clock },
  running: { label: "Running",        className: STATUS_COLORS.running,      icon: Loader2 },
  completed: { label: "Completed",    className: STATUS_COLORS.completed,   icon: CheckCircle2 },
  failed: { label: "Failed",          className: STATUS_COLORS.failed,      icon: XCircle },
  human_review: { label: "Needs review", className: STATUS_COLORS.human_review, icon: AlertTriangle },
  cancelled: { label: "Cancelled",     className: STATUS_COLORS.cancelled,   icon: Ban },
};

export const OUTCOME_COLORS: Record<string, string> = {
  gold: "bg-[var(--success-muted)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_30%,var(--line))]",
  silver: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]",
  bronze: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-default)]",
  partial: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]",
  failed: "bg-[var(--error-muted)] text-[var(--error)] border-[color-mix(in_srgb,var(--error)_30%,var(--line))]",
};

export const OUTCOMES: Record<string, OutcomeDescriptor> = {
  gold:    { label: "Gold",    className: OUTCOME_COLORS.gold,    icon: Trophy },
  silver:  { label: "Silver",  className: OUTCOME_COLORS.silver,  icon: Medal },
  bronze:  { label: "Bronze",  className: OUTCOME_COLORS.bronze,  icon: Award },
  partial: { label: "Partial", className: OUTCOME_COLORS.partial, icon: CircleDashed },
  failed:  { label: "Failed",  className: OUTCOME_COLORS.failed,  icon: CircleSlash },
};

// PR Suggestion lifecycle — distinct from the generic STATUS map (no "running")
export const PR_STATUSES: Record<string, StatusDescriptor> = {
  pending:  { label: "Pending review", className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]", icon: Clock },
  opened:   { label: "PR opened",      className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]", icon: GitPullRequest },
  merged:   { label: "Merged",         className: "bg-[var(--success-muted)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_30%,var(--line))]", icon: CheckCircle2 },
  rejected: { label: "Rejected",       className: "bg-[var(--error-muted)] text-[var(--error)] border-[color-mix(in_srgb,var(--error)_30%,var(--line))]", icon: XCircle },
};

// N23 improvement plan lifecycle
export const IMPROVEMENT_PLAN_STATUSES: Record<string, StatusDescriptor> = {
  draft:           { label: "Draft",           className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]", icon: Clock },
  pending_review:  { label: "Pending review",  className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]", icon: Clock },
  approved:        { label: "Approved",        className: "bg-[var(--success-muted)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_30%,var(--line))]", icon: CheckCircle2 },
  pr_opened:       { label: "PR opened",       className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]", icon: GitPullRequest },
  merged:          { label: "Merged",          className: "bg-[var(--success-muted)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_30%,var(--line))]", icon: CheckCircle2 },
  rejected:        { label: "Rejected",        className: "bg-[var(--error-muted)] text-[var(--error)] border-[color-mix(in_srgb,var(--error)_30%,var(--line))]", icon: XCircle },
  snoozed:         { label: "Snoozed",         className: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-default)]",   icon: Ban },
  superseded:      { label: "Superseded",      className: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-default)]",   icon: CircleSlash },
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
