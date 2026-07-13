"use client";

/**
 * SidebarSettingsTab — wrapper used by settings/page.tsx to mount the
 * /settings?tab=sidebar page inside the legacy tab-rail. The real
 * editor lives at /settings/(tabs)/sidebar/page.tsx; this component
 * re-exports it in `embedded` mode so it renders a compact inline
 * header instead of duplicating the tab rail's own PageContent +
 * "Settings" PageHeader.
 */

import SidebarSettingsPage from "../(tabs)/sidebar/page";

export function SidebarSettingsTab() {
  return <SidebarSettingsPage embedded />;
}
