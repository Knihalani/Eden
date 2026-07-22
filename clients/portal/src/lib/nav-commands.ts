/**
 * Derive command-palette entries from the sidebar config so Cmd+K
 * and the left nav never drift apart.
 */

import {
  Bell,
  Bot,
  CreditCard,
  Database,
  EyeOff,
  FileArchive,
  FileText,
  FlaskConical,
  Key,
  KeyRound,
  Settings2,
  Shield,
  ShieldAlert,
  Sparkles,
  Plus,
  MessageSquare,
  Server,
  Activity,
  BarChart2,
  Building2,
  Users,
  User,
  Code,
  Terminal,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { DEFAULT_SIDEBAR, SIDEBAR_GROUP_LABELS, SIDEBAR_ITEM_LABELS, type SidebarGroup, type SidebarIcon, type SidebarItem } from "@/lib/sidebar-config";

/** Maps sidebar group IDs → product IA labels (ids match labels after Wave 3). */
export const GROUP_LABEL: Record<SidebarGroup["id"], string> = {
  ...SIDEBAR_GROUP_LABELS,
};

export type NavCommand = {
  href: string;
  label: string;
  description?: string;
  group: string;
  icon: SidebarIcon | LucideIcon;
  kind?: "route" | "action";
};

/** Special palette href — opens ChatSidebar via custom event (not a route). */
export const OPEN_AI_CHAT_HREF = "eden:open-ai-chat";

function walkItems(
  items: SidebarItem[],
  group: SidebarGroup["id"],
  out: NavCommand[],
) {
  for (const item of items) {
    out.push({
      href: item.href,
      label: SIDEBAR_ITEM_LABELS[item.id] ?? item.id,
      description: item.descriptionKey,
      group: GROUP_LABEL[group],
      icon: item.icon,
    });
    if (item.children) walkItems(item.children, group, out);
  }
}

/** U18 quick actions — surfaced in ⌘K alongside routes. */
export const PALETTE_ACTIONS: NavCommand[] = [
  {
    href: OPEN_AI_CHAT_HREF,
    label: "Ask AI",
    description:
      "Open assistant — header · FAB · ⌘K/⌘J. Ask about traces, filters, cost.",
    group: "Actions",
    icon: MessageSquare,
    kind: "action",
  },
  {
    href: "/alerts?tab=rules",
    label: "Create alert",
    description: "Open alert rules to define a new threshold or signal rule.",
    group: "Actions",
    icon: Plus,
    kind: "action",
  },
  {
    href: "/evals",
    label: "Open Evals",
    description: "Datasets, playground, and offline experiments — Observe → Evaluate loop.",
    group: "Actions",
    icon: FlaskConical,
    kind: "action",
  },
  {
    href: "/evals?tab=playgrounds",
    label: "Open playground",
    description: "Author and test prompts against production traces.",
    group: "Actions",
    icon: FlaskConical,
    kind: "action",
  },
  {
    href: "/issues",
    label: "Go to issues",
    description: "Triage grouped agent failures and incident clusters.",
    group: "Actions",
    icon: ShieldAlert,
    kind: "action",
  },
  {
    href: "/improve?tab=artifacts",
    label: "Review artifacts",
    description: "Shadow runtime fixes awaiting evidence-gated promotion.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/analytics?tab=topics",
    label: "Topic clusters",
    description: "Explore semantic topic clusters from trace traffic.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/improve?tab=ledger",
    label: "Open ledger",
    description: "Compounding institutional memory across agents.",
    group: "Actions",
    icon: FileText,
    kind: "action",
  },
  {
    href: "/prompts",
    label: "Open prompts",
    description: "Version and manage prompt templates.",
    group: "Actions",
    icon: Code,
    kind: "action",
  },
  {
    href: "/alerts",
    label: "View alerts",
    description: "Acknowledge threshold notifications and on-call pages.",
    group: "Actions",
    icon: Bell,
    kind: "action",
  },
  {
    href: "/improve/online-scoring",
    label: "Online scoring",
    description: "Production scorers (code → SLM → LLM) — Advanced Improve.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/improve/scorecard",
    label: "Process scorecard",
    description: "Synthetic engineering gates — Advanced Improve only.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/improve/change-impact",
    label: "Change impact preview",
    description: "Replay stratified traffic before shipping changes — Advanced Improve.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
];

/**
 * Wave 1.7 — ⌘K audit entry targets canonical `/audit-trail` (M3/M9).
 * Settings `?tab=audit-log` bookmarks redirect separately; nav no longer deep-links that tab.
 */
export const WS1_NAV_AUDIT_REDIRECT_COMPLETED = true as const;

/** Wave E1 — Evaluate dual-entry hygiene: sidebar + ⌘K advertise `/evals` only. */
export const WAVE_E1_NAV_HYGIENE_COMPLETED = true as const;

/**
 * Settings tab deep-links for ⌘K (peer S-06). Labels match the settings rail.
 * Hidden soft-launch tabs (roles, sso) omitted from the palette.
 * Audit trail aliases to `/audit-trail` (unified compliance), not `?tab=audit-log`.
 */
export const SETTINGS_TAB_COMMANDS: NavCommand[] = [
  {
    href: "/settings",
    label: "Settings · Overview",
    description: "Workspace settings overview — members, billing, security, and more.",
    group: "Settings",
    icon: Settings2,
  },
  {
    href: "/settings?tab=org",
    label: "Settings · Workspace",
    description: "Workspace name, slug, archive, and ownership transfer.",
    group: "Settings",
    icon: Building2,
  },
  {
    href: "/settings?tab=account",
    label: "Settings · Account",
    description: "Your profile and account preferences.",
    group: "Settings",
    icon: User,
  },
  {
    href: "/settings?tab=api-keys",
    label: "Settings · API Keys",
    description: "Create and revoke org API keys for SDK ingest.",
    group: "Settings",
    icon: Key,
  },
  {
    href: "/settings?tab=members",
    label: "Settings · Members",
    description: "Invite teammates and manage membership.",
    group: "Settings",
    icon: Users,
  },
  {
    href: "/settings?tab=references",
    label: "Settings · Code References",
    description: "Link GitHub repos for code references.",
    group: "Settings",
    icon: Code,
  },
  {
    href: "/settings?tab=mcp",
    label: "Settings · MCP",
    description: "Model Context Protocol server configuration.",
    group: "Settings",
    icon: Terminal,
  },
  {
    href: "/settings?tab=security",
    label: "Settings · Security",
    description: "2FA enforcement and password policy.",
    group: "Settings",
    icon: Shield,
  },
  {
    href: "/settings?tab=scim",
    label: "Settings · SCIM",
    description: "Directory provisioning (Okta, Entra).",
    group: "Settings",
    icon: KeyRound,
  },
  {
    href: "/settings?tab=gateway",
    label: "Settings · AI Gateway",
    description: "LLM proxy routing and model defaults.",
    group: "Settings",
    icon: Server,
  },
  {
    href: "/settings?tab=pii",
    label: "Settings · PII Policy",
    description: "Redaction and privacy scrub rules.",
    group: "Settings",
    icon: EyeOff,
  },
  {
    href: "/settings?tab=retention",
    label: "Settings · Retention",
    description: "Trace retention TTL and lifecycle.",
    group: "Settings",
    icon: Database,
  },
  {
    href: "/settings?tab=exports",
    label: "Settings · Exports",
    description: "Scheduled and one-shot data exports.",
    group: "Settings",
    icon: FileArchive,
  },
  {
    href: "/audit",
    label: "Audit trail",
    description: "Unified compliance — privileged events and AuditPacks.",
    group: "Settings",
    icon: FileText,
  },
  {
    href: "/settings?tab=status",
    label: "Settings · Platform status",
    description: "Dependency health and platform status.",
    group: "Settings",
    icon: Activity,
  },
  {
    href: "/settings?tab=analytics",
    label: "Settings · Analytics",
    description: "Org usage analytics preferences.",
    group: "Settings",
    icon: BarChart2,
  },
  {
    href: "/settings?tab=billing",
    label: "Settings · Billing",
    description: "Plan, invoices, and payment method.",
    group: "Settings",
    icon: CreditCard,
  },
  {
    href: "/settings?tab=finops",
    label: "Settings · FinOps kills",
    description: "Cost kill switches and FinOps controls.",
    group: "Settings",
    icon: Wallet,
  },
  {
    href: "/settings?tab=autonomous",
    label: "Settings · Autonomous",
    description: "Heal / intelligence agent autonomy tiers.",
    group: "Settings",
    icon: Bot,
  },
  {
    href: "/settings?tab=sidebar",
    label: "Settings · Sidebar",
    description: "Nav density and pinned sidebar items.",
    group: "Settings",
    icon: Settings2,
  },
];

/** Flat command list mirroring DEFAULT_SIDEBAR (including nested children). */
export function buildNavCommands(): NavCommand[] {
  const out: NavCommand[] = [];
  for (const group of DEFAULT_SIDEBAR) {
    walkItems(group.items, group.id, out);
  }
  return [...out, ...PALETTE_ACTIONS, ...SETTINGS_TAB_COMMANDS];
}

/** Sidebar href paths (no query) for CI route-agreement checks. */
export function collectSidebarHrefs(): string[] {
  const hrefs: string[] = [];
  function walk(items: SidebarItem[]) {
    for (const item of items) {
      hrefs.push(item.href.split("?")[0]);
      if (item.children) walk(item.children);
    }
  }
  for (const group of DEFAULT_SIDEBAR) {
    walk(group.items);
  }
  return hrefs;
}
