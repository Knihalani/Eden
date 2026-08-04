/**
 * Derive command-palette entries from lab/nav (PRIMARY_NAV / NAV_SECTIONS)
 * so Cmd+K and the live sidebar never drift apart.
 */

import {
  Bell,
  FlaskConical,
  FileText,
  Key,
  Settings2,
  ShieldAlert,
  Sparkles,
  Plus,
  MessageSquare,
  Building2,
  Users,
  Home,
  GitBranch,
  AlertTriangle,
  DollarSign,
  Network,
  Bug,
  GitCompare,
  Play,
  Bot,
  Activity,
  Shield,
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
  playgrounds: Play,
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
    href: "/signals?create=1",
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
    href: "/evals?mode=playground",
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
    href: "/improve?mode=queue",
    label: "Review queue",
    description: "Shadow runtime fixes awaiting evidence-gated promotion.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/improve?mode=plan",
    label: "Open plan",
    description: "Plan detail and compounding institutional memory across agents.",
    group: "Actions",
    icon: FileText,
    kind: "action",
  },
  {
    href: "/prompts",
    label: "Open prompts",
    description: "Version and manage prompt templates.",
    group: "Actions",
    icon: FileText,
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
];

/**
 * Wave 1.7 — ⌘K audit entry targets Settings audit mode (`?mode=audit`).
 * Legacy `/audit` soft-lands elsewhere; nav deep-links the live settings surface.
 */
export const WS1_NAV_AUDIT_REDIRECT_COMPLETED = true as const;

/** Wave E1 — Evaluate dual-entry hygiene: sidebar + ⌘K advertise `/evals` only. */
export const WAVE_E1_NAV_HYGIENE_COMPLETED = true as const;

/**
 * Settings mode deep-links for ⌘K.
 * Only live modes: Overview (workspace), Keys, Members, Audit.
 */
export const SETTINGS_TAB_COMMANDS: NavCommand[] = [
  {
    href: "/settings?mode=workspace",
    label: "Settings · Overview",
    description: "Workspace settings overview — prefs, health, and shortcuts.",
    group: "Settings",
    icon: Building2,
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
    href: "/settings?mode=audit",
    label: "Audit trail",
    description: "Unified compliance — privileged events and AuditPacks.",
    group: "Settings",
    icon: FileText,
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
