/** Analytics hub tab ids (Later secondary surface). */
export const ANALYTICS_TABS = [
  "overview",
  "insights",
  "topics",
  "tools",
  "users",
] as const;

export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];
