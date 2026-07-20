"use client";

/**
 * /settings/sidebar deep-link — full-page chrome around SidebarSettingsView.
 * Tab-rail embedding uses `_components/sidebar-settings-tab.tsx` instead.
 */

import { SidebarSettingsView } from "../../_components/sidebar-settings-view";

export default function SidebarSettingsPage() {
  return <SidebarSettingsView embedded={false} />;
}
