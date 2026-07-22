/**
 * Legacy portal chrome entry — rebuild uses AppShell from `@/components/shell/app-shell`.
 * Kept as a thin alias so any stale imports resolve without the pre-teardown chrome stack.
 */

export { AppShell as PortalChrome } from "@/components/shell/app-shell";
