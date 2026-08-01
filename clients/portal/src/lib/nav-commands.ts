/**
 * Derive command-palette entries from lab/nav (PRIMARY_NAV / NAV_SECTIONS)
 * so Cmd+K and the live sidebar never drift apart.
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
  Wallet,
  Home,
  GitBranch,
  AlertTriangle,
  DollarSign,
  Network,
  Bug,
  GitCompare,
  type LucideIcon,
} from "lucide-react";
import {
  NAV_SECTIONS,
  PRIMARY_NAV,
  type NavIcon,
  type NavSection,
} from "@/lab/nav";

/** Section id → palette group label (observe has no rail label). */
export const GROUP_LABEL: Record<NavSection["id"], string> = {
  observe: "Observe",
  evaluate: "Evaluate",
  improve: "Improve",
  assist: "Assist",
  workspace: "Workspace",
};

export type NavCommand = {
  href: string;
  label: string;
  description?: string;
  group: string;
  icon: LucideIcon;
  kind?: "route" | "action";
};

/** Special palette href — opens Assistant (not a soft-land route). */
export const OPEN_AI_CHAT_HREF = "eden:open-ai-chat";

const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  home: Home,
  agents: Bot,
  traces: GitBranch,
  issues: AlertTriangle,
  signals: Activity,
  evals: FlaskConical,
  improve: Sparkles,
  cost: DollarSign,
  gateway: Network,
  agent: MessageSquare,
  debugger: Bug,
  compare: GitCompare,
  prompts: FileText,
  guardrails: Shield,
  settings: Settings2,
};

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
    href: "/signals",
    label: "Create detector",
    description: "Open Detectors to define a new threshold or signal rule.",
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
    href: "/signals",
    label: "View detectors",
    description: "Threshold notifications and custom signal rules.",
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
 * Wave 1.7 — ⌘K audit entry targets Settings audit mode (`?mode=audit`).
 * Legacy `/audit` soft-lands elsewhere; nav deep-links the live settings surface.
 */
export const WS1_NAV_AUDIT_REDIRECT_COMPLETED = true as const;

/** Wave E1 — Evaluate dual-entry hygiene: sidebar + ⌘K advertise `/evals` only. */
export const WAVE_E1_NAV_HYGIENE_COMPLETED = true as const;

/**
 * Settings tab deep-links for ⌘K (peer S-06). Labels match the settings rail.
 * Hidden soft-launch tabs (roles, sso) omitted from the palette.
 * Audit trail aliases to `/settings?mode=audit` (settings audit packs/events).
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
    href: "/settings?mode=workspace",
    label: "Settings · Workspace",
    description: "Workspace name, slug, archive, and ownership transfer.",
    group: "Settings",
    icon: Building2,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Account",
    description: "Your profile and account preferences.",
    group: "Settings",
    icon: User,
  },
  {
    href: "/settings?mode=keys",
    label: "Settings · API Keys",
    description: "Create and revoke org API keys for SDK ingest.",
    group: "Settings",
    icon: Key,
  },
  {
    href: "/settings?mode=members",
    label: "Settings · Members",
    description: "Invite teammates and manage membership.",
    group: "Settings",
    icon: Users,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Code References",
    description: "Link GitHub repos for code references.",
    group: "Settings",
    icon: Code,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Security",
    description: "2FA enforcement and password policy.",
    group: "Settings",
    icon: Shield,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · SCIM",
    description: "Directory provisioning (Okta, Entra).",
    group: "Settings",
    icon: KeyRound,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · AI Gateway",
    description: "LLM proxy routing and model defaults.",
    group: "Settings",
    icon: Server,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · PII Policy",
    description: "Redaction and privacy scrub rules.",
    group: "Settings",
    icon: EyeOff,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Retention",
    description: "Trace retention TTL and lifecycle.",
    group: "Settings",
    icon: Database,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Exports",
    description: "Scheduled and one-shot data exports.",
    group: "Settings",
    icon: FileArchive,
  },
  {
    href: "/settings?mode=audit",
    label: "Audit trail",
    description: "Unified compliance — privileged events and AuditPacks.",
    group: "Settings",
    icon: FileText,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Platform status",
    description: "Dependency health and platform status.",
    group: "Settings",
    icon: Activity,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Analytics",
    description: "Org usage analytics preferences.",
    group: "Settings",
    icon: BarChart2,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Billing",
    description: "Plan, invoices, and payment method.",
    group: "Settings",
    icon: CreditCard,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · FinOps kills",
    description: "Cost kill switches and FinOps controls.",
    group: "Settings",
    icon: Wallet,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Autonomous",
    description: "Heal / intelligence agent autonomy tiers.",
    group: "Settings",
    icon: Bot,
  },
  {
    href: "/settings?mode=workspace",
    label: "Settings · Sidebar",
    description: "Nav density and pinned sidebar items.",
    group: "Settings",
    icon: Settings2,
  },
];

/** Flat command list mirroring lab/nav NAV_SECTIONS + actions + settings tabs. */
export function buildNavCommands(): NavCommand[] {
  const out: NavCommand[] = [];
  for (const section of NAV_SECTIONS) {
    const group = GROUP_LABEL[section.id];
    for (const item of section.items) {
      out.push({
        href: item.href,
        label: item.label,
        group,
        icon: NAV_ICONS[item.icon],
        kind: "route",
      });
    }
  }
  return [...out, ...PALETTE_ACTIONS, ...SETTINGS_TAB_COMMANDS];
}

/** Live nav href paths (no query) for CI route-agreement checks. */
export function collectSidebarHrefs(): string[] {
  return PRIMARY_NAV.map((item) => item.href.split("?")[0]);
}
