import { agentById } from "@/lab/fixtures/agents";

export type MemberRole = "owner" | "admin" | "member" | "viewer";
export type MemberStatus = "active" | "invited" | "disabled";
export type KeyStatus = "active" | "revoked";
export type AuditPackKind = "ledger" | "export" | "verify";
export type DensityPref = "comfortable" | "compact";
export type NotifyChannel = "email" | "webhook";
export type RetentionDays = 7 | 30 | 90 | 365;

export type KeyScope =
  | "ingest"
  | "traces:write"
  | "traces:read"
  | "evals:run"
  | "datasets:read";

export const KEY_SCOPE_OPTIONS: { id: KeyScope; label: string }[] = [
  { id: "ingest", label: "Ingest" },
  { id: "traces:write", label: "Traces write" },
  { id: "traces:read", label: "Traces read" },
  { id: "evals:run", label: "Evals run" },
  { id: "datasets:read", label: "Datasets read" },
];

export const TIMEZONE_OPTIONS = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
] as const;

export const RETENTION_OPTIONS: RetentionDays[] = [7, 30, 90, 365];

export type WorkspaceFixture = {
  id: string;
  name: string;
  slug: string;
  planLabel: string;
  isPersonal: boolean;
  timezone: string;
  createdAt: string;
  density: DensityPref;
  retentionDays: RetentionDays;
  piiRedaction: boolean;
  defaultNotifyChannel: NotifyChannel;
  defaultNotifyDestination: string;
};

export type MemberFixture = {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  status: MemberStatus;
  lastActive: string;
};

export type ApiKeyFixture = {
  id: string;
  name: string;
  prefix: string;
  /** Full secret — only present right after create in the lab. */
  secret?: string;
  scopes: KeyScope[];
  status: KeyStatus;
  createdAt: string;
  lastUsed: string | null;
  createdBy: string;
};

export type AuditEventFixture = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: string;
  /** Optional deep-link into Settings */
  href?: string;
};

export type AuditPackFixture = {
  id: string;
  at: string;
  agentId: string;
  kind: AuditPackKind;
  actor: string;
  entryHash: string;
  verified: boolean;
  rows: number;
};

export const WORKSPACE: WorkspaceFixture = {
  id: "ws_default",
  name: "",
  slug: "",
  planLabel: "",
  isPersonal: true,
  timezone: "UTC",
  createdAt: "",
  density: "comfortable",
  retentionDays: 30,
  piiRedaction: true,
  defaultNotifyChannel: "email",
  defaultNotifyDestination: "",
};

export const MEMBERS: MemberFixture[] = [];

export const API_KEYS: ApiKeyFixture[] = [];

export const AUDIT_EVENTS: AuditEventFixture[] = [];

export const AUDIT_PACKS: AuditPackFixture[] = [];

export function activeKeys(keys: ApiKeyFixture[] = API_KEYS): ApiKeyFixture[] {
  return keys.filter((k) => k.status === "active");
}

export function keyHealth(keys: ApiKeyFixture[] = API_KEYS): "ok" | "fail" {
  return activeKeys(keys).length > 0 ? "ok" : "fail";
}

export function memberCounts(members: MemberFixture[] = MEMBERS) {
  return {
    total: members.length,
    active: members.filter((m) => m.status === "active").length,
    invited: members.filter((m) => m.status === "invited").length,
    disabled: members.filter((m) => m.status === "disabled").length,
  };
}

export function packsForAgent(
  agentId: string | "all",
  packs: AuditPackFixture[] = AUDIT_PACKS,
): AuditPackFixture[] {
  if (agentId === "all") return packs;
  return packs.filter((p) => p.agentId === agentId);
}

export function packVerifySummary(packs: AuditPackFixture[] = AUDIT_PACKS) {
  const verifies = packs.filter((p) => p.kind === "verify");
  const broken = verifies.filter((p) => !p.verified).length;
  return {
    total: verifies.length,
    broken,
    ok: verifies.length - broken,
  };
}

export function auditSnapshot(input?: {
  keys?: ApiKeyFixture[];
  members?: MemberFixture[];
  packs?: AuditPackFixture[];
  events?: AuditEventFixture[];
}) {
  const keys = input?.keys ?? API_KEYS;
  const members = input?.members ?? MEMBERS;
  const packs = input?.packs ?? AUDIT_PACKS;
  const events = input?.events ?? AUDIT_EVENTS;
  return {
    keys: keyHealth(keys),
    members: memberCounts(members),
    packs: packVerifySummary(packs),
    latestEvent: events[0] ?? null,
  };
}

export function makeAuditEvent(
  partial: Omit<AuditEventFixture, "id" | "at"> & { at?: string },
): AuditEventFixture {
  return {
    id: `ae_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    at: partial.at ?? "just now",
    actor: partial.actor,
    action: partial.action,
    target: partial.target,
    detail: partial.detail,
    href: partial.href,
  };
}

export function makeApiKeySecret(prefix: string): string {
  const tail = Array.from({ length: 24 }, () =>
    Math.random().toString(36).slice(2, 3),
  ).join("");
  return `${prefix}_${tail}`;
}

export function roleLabel(role: MemberRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  return "Viewer";
}

export function memberStatusLabel(status: MemberStatus): string {
  if (status === "invited") return "Invited";
  if (status === "disabled") return "Disabled";
  return "Active";
}

export function keyStatusLabel(status: KeyStatus): string {
  return status === "revoked" ? "Revoked" : "Active";
}

export function packKindLabel(kind: AuditPackKind): string {
  if (kind === "export") return "Export";
  if (kind === "verify") return "Verify";
  return "Ledger";
}

export function densityLabel(d: DensityPref): string {
  return d === "compact" ? "Compact" : "Comfortable";
}

export function agentName(agentId: string): string {
  return agentById(agentId)?.name ?? agentId;
}

export function eventActionFamily(action: string): string {
  if (action.startsWith("api_key")) return "keys";
  if (action.startsWith("member")) return "members";
  if (action.startsWith("audit") || action.startsWith("budget")) return "ops";
  if (action.startsWith("workspace")) return "workspace";
  return "other";
}
