/**
 * Derive command-palette entries from the sidebar config so Cmd+K
 * and the left nav never drift apart.
 */

import {
  Bell,
  FileText,
  FlaskConical,
  ShieldAlert,
  Sparkles,
  Plus,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { DEFAULT_SIDEBAR, type SidebarGroup, type SidebarIcon, type SidebarItem } from "@/lib/sidebar-config";

const GROUP_LABEL: Record<SidebarGroup["id"], string> = {
  build: "Home",
  observe: "Observe",
  optimize: "Improve",
  automate: "Evaluate",
  workspace: "Workspace",
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
      label: item.label,
      description: item.description,
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
    description: "Open the ChatSidebar assistant (⌘J). Ask about traces, filters, cost.",
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
    href: "/artifacts",
    label: "Review artifacts",
    description: "Shadow runtime fixes awaiting evidence-gated promotion.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/insights/topics",
    label: "Topic clusters",
    description: "Explore semantic topic clusters from trace traffic.",
    group: "Actions",
    icon: Sparkles,
    kind: "action",
  },
  {
    href: "/ledger",
    label: "Open ledger",
    description: "Compounding institutional memory across agents.",
    group: "Actions",
    icon: FileText,
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
];

/** Flat command list mirroring DEFAULT_SIDEBAR (including nested children). */
export function buildNavCommands(): NavCommand[] {
  const out: NavCommand[] = [];
  for (const group of DEFAULT_SIDEBAR) {
    walkItems(group.items, group.id, out);
  }
  return [...out, ...PALETTE_ACTIONS];
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
