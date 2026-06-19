"use client";

/**
 * SidebarSettingsTab — wrapper used by settings/page.tsx to mount the
 * /settings?tab=sidebar page inside the legacy tab-rail. The real
 * editor lives at /settings/(tabs)/sidebar/page.tsx; this component
 * simply re-exports it for the legacy tab-rail.
 */

import SidebarSettingsPage from "../(tabs)/sidebar/page";

export function SidebarSettingsTab() {
  return <SidebarSettingsPage />;
}
