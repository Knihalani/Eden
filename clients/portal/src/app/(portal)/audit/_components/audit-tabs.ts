/** Audit hub tab ids (surfaces/audit.md). */
export const AUDIT_TABS = ["events", "packs"] as const;
export type AuditTab = (typeof AUDIT_TABS)[number];
