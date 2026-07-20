"use client";

/**
 * SidebarSettingsTab — wrapper used by settings/page.tsx to mount the
 * sidebar editor inside the legacy tab-rail in `embedded` mode.
 */

import { SidebarSettingsView } from "./sidebar-settings-view";

export function SidebarSettingsTab() {
  return <SidebarSettingsView embedded />;
}
