/**
 * Settings tab registry — Wave 1 extract from settings hub.
 * Single source of truth for tab ids, categories, ghosts, and audit redirect.
 */

import type { LucideIcon } from "lucide-react";
import {
  Building2,
  Users,
  User,
  Code,
  Key,
  FileText,
  Shield,
  CreditCard,
  KeyRound,
  BarChart2,
  Server,
  EyeOff,
  Database,
  FileArchive,
  Settings2,
  Bot,
  Terminal,
  Activity,
  Wallet,
  LayoutDashboard,
  Inbox,
} from "lucide-react";

/** Icons used by TabDef entries — re-exported for settings shell consumers. */
export {
  Building2,
  Users,
  User,
  Code,
  Key,
  FileText,
  Shield,
  CreditCard,
  KeyRound,
  BarChart2,
  Server,
  EyeOff,
  Database,
  FileArchive,
  Settings2,
  Bot,
  Terminal,
  Activity,
  Wallet,
  LayoutDashboard,
  Inbox,
};

export type Tab =
  | "overview"
  | "org"
  | "members"
  | "references"
  | "api-keys"
  | "mcp"
  | "security"
  | "scim"
  | "audit-log"
  | "analytics"
  | "billing"
  | "gateway"
  | "pii"
  | "retention"
  | "exports"
  | "webhooks-dlq"
  | "sidebar"
  | "autonomous"
  | "account"
  | "status"
  | "finops";

export type SettingsCategory =
  | "Org"
  | "Members"
  | "Security"
  | "Billing"
  | "Advanced";

/** Display labels for category pills (id stays "Org" for deep-link stability). */
export const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  Org: "Workspace",
  Members: "Members",
  Security: "Security",
  Billing: "Billing",
  Advanced: "Advanced",
};

export type TabDef = {
  id: Tab;
  label: string;
  icon: LucideIcon;
  category: SettingsCategory;
  /** Shown when Advanced is collapsed / default Settings paint. */
  defaultVisible?: boolean;
  keywords?: string[];
  /**
   * Redirect-only alias — not shown in rail/search/categories.
   * Hub still handles `?tab=` and sends users to `SETTINGS_AUDIT_LOG_REDIRECT_HREF`.
   */
  redirectOnly?: boolean;
};

/**
 * Soft-launch ghosts (roles / SSO) are intentionally absent from TABS.
 * Deep-links still resolve to a quiet notice without advertising in the rail.
 */
export const GHOST_TABS = new Set(["roles", "sso"]);

/** Canonical compliance URL — Settings ?tab=audit-log redirects here. */
export const SETTINGS_AUDIT_LOG_REDIRECT_HREF = "/audit" as const;

/**
 * Soft-launch ghosts (roles / SSO) stay out of IA.
 * Daily ≤8: overview, account, org, members, api-keys, gateway, billing, security.
 * Advanced tabs are progressive disclosure only (surfaces/settings.md §3).
 */
export const TABS: ReadonlyArray<TabDef> = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    category: "Org",
    defaultVisible: true,
    keywords: ["workspace", "home", "summary", "plan", "keys", "members"],
  },
  {
    id: "account",
    label: "Account",
    icon: User,
    category: "Org",
    defaultVisible: true,
    keywords: ["profile", "user", "me", "password", "avatar", "2fa", "density", "locale"],
  },
  {
    id: "org",
    label: "Org",
    icon: Building2,
    category: "Org",
    defaultVisible: true,
    keywords: ["workspace", "team", "slug", "archive", "delete", "transfer"],
  },
  {
    id: "members",
    label: "Members",
    icon: Users,
    category: "Members",
    defaultVisible: true,
    keywords: ["invite", "people", "team", "remove", "role"],
  },
  {
    id: "api-keys",
    label: "API Keys",
    icon: Key,
    category: "Org",
    defaultVisible: true,
    keywords: ["token", "credentials", "sdk", "secret", "revoke", "ingest"],
  },
  {
    id: "gateway",
    label: "Gateway",
    icon: Server,
    category: "Org",
    defaultVisible: true,
    keywords: ["models", "llm", "proxy", "routing", "base_url", "connect"],
  },
  {
    id: "billing",
    label: "Billing",
    icon: CreditCard,
    category: "Billing",
    defaultVisible: true,
    keywords: ["plan", "stripe", "invoice", "subscription", "payment", "limits", "spend"],
  },
  {
    id: "security",
    label: "Security",
    icon: Shield,
    category: "Security",
    defaultVisible: true,
    keywords: ["2fa", "mfa", "totp", "password", "enforcement", "alerts", "channels"],
  },
  {
    id: "audit-log",
    label: "Audit Log",
    icon: FileText,
    // Kept for deep-link recognition only — Compliance lives on /audit.
    category: "Org",
    redirectOnly: true,
    keywords: ["audit", "trail", "compliance", "events", "log", "soc2", "activity"],
  },
  {
    id: "references",
    label: "Code References",
    icon: Code,
    category: "Advanced",
    keywords: ["github", "repo", "source", "code"],
  },
  {
    id: "mcp",
    label: "MCP",
    icon: Terminal,
    category: "Advanced",
    keywords: ["model context", "tools", "server", "protocol"],
  },
  {
    id: "scim",
    label: "SCIM",
    icon: KeyRound,
    category: "Advanced",
    keywords: ["provisioning", "directory", "okta", "entra", "users", "scim"],
  },
  {
    id: "pii",
    label: "PII Policy",
    icon: EyeOff,
    category: "Advanced",
    keywords: ["privacy", "redact", "scrub", "gdpr", "phi"],
  },
  {
    id: "retention",
    label: "Retention",
    icon: Database,
    category: "Advanced",
    keywords: ["delete", "lifecycle", "storage", "ttl"],
  },
  {
    id: "exports",
    label: "Exports",
    icon: FileArchive,
    category: "Advanced",
    keywords: ["download", "gdpr", "data", "zip"],
  },
  {
    id: "webhooks-dlq",
    label: "Webhook DLQ",
    icon: Inbox,
    category: "Advanced",
    keywords: ["webhook", "dlq", "dead letter", "replay", "delivery"],
  },
  {
    id: "status",
    label: "Platform status",
    icon: Activity,
    category: "Advanced",
    keywords: ["health", "uptime", "incidents"],
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: BarChart2,
    category: "Advanced",
    keywords: ["metrics", "usage", "charts"],
  },
  {
    id: "finops",
    label: "FinOps kills",
    icon: Wallet,
    category: "Advanced",
    keywords: ["finops", "kill", "kills", "cost", "feature kill", "switch"],
  },
  {
    id: "autonomous",
    label: "Autonomous",
    icon: Bot,
    category: "Advanced",
    keywords: ["heal", "intelligence", "agent", "cron", "destructive"],
  },
  {
    id: "sidebar",
    label: "Sidebar",
    icon: Settings2,
    category: "Advanced",
    keywords: ["navigation", "nav", "pin", "layout", "density"],
  },
];

export const CATEGORY_ORDER: SettingsCategory[] = [
  "Org",
  "Members",
  "Security",
  "Billing",
  "Advanced",
];

/** Tabs painted in Settings rail / search (excludes redirect-only aliases). */
export function isRailTab(tab: TabDef): boolean {
  return !tab.redirectOnly;
}

/** Exit criterion: default Settings paint shows ≤8 daily tabs. */
export const DEFAULT_VISIBLE_TAB_IDS = TABS.filter((t) => t.defaultVisible).map((t) => t.id);

/** Phase 7 exit marker — settings usable without second 240px rail. */
export const WAVE9_SETTINGS_COMPLETED = true as const;

/** Daily tabs ≤8 (surfaces/settings.md §3.1). */
export const WAVE9_DAILY_TAB_CAP = 8 as const;

/** Phase 7 rebuild — daily strip ids (order matters). */
export const SETTINGS_DAILY_TAB_IDS = [
  "overview",
  "account",
  "org",
  "members",
  "api-keys",
  "gateway",
  "billing",
  "security",
] as const;

/** Wave 9 — shell LOC ≤400, dual-route stubs redirect-only, ⌘K parity. */
export const WS9_SHELL_HYGIENE_COMPLETED = true as const;

/** Wave 1 — tab registry extract complete (shell wires separately). */
export const WS1_TAB_REGISTRY_COMPLETED = true;

/** Wave 1 — settings hub shell orchestrator complete (≤400 LOC gate). */
export const WS1_SETTINGS_SHELL_COMPLETED = true;

export function tabMatchesQuery(tab: TabDef, normalisedQuery: string): boolean {
  if (!normalisedQuery) return true;
  const hay = `${tab.label} ${(tab.keywords ?? []).join(" ")}`.toLowerCase();
  const tokens = normalisedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) => hay.includes(tok));
}
