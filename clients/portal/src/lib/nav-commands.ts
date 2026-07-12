/**
 * Derive command-palette entries from the sidebar config so Cmd+K
 * and the left nav never drift apart.
 */

import { DEFAULT_SIDEBAR, type SidebarGroup, type SidebarIcon, type SidebarItem } from "@/lib/sidebar-config";

const GROUP_LABEL: Record<SidebarGroup["id"], string> = {
  build: "Build",
  observe: "Observe",
  optimize: "Optimize",
  automate: "Automate",
  workspace: "Workspace",
};

export type NavCommand = {
  href: string;
  label: string;
  description?: string;
  group: string;
  icon: SidebarIcon;
};

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

/** Flat command list mirroring DEFAULT_SIDEBAR (including nested children). */
export function buildNavCommands(): NavCommand[] {
  const out: NavCommand[] = [];
  for (const group of DEFAULT_SIDEBAR) {
    walkItems(group.items, group.id, out);
  }
  return out;
}
