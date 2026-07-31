/**
 * Project-wide constants. Single source of truth for product identity,
 * support contacts, and external URLs that appear in multiple surfaces.
 *
 * ponytail: keep this file flat and dependency-free — it's imported
 * from both client and server contexts (marketing page, auth pages,
 * settings, billing).
 */

export const PRODUCT_NAME = "Eden";
export const PRODUCT_TAGLINE = "Observability + improvement for AI agents and LLM apps.";
export const PRODUCT_VERSION = "v3.0";
export const PRODUCT_COPYRIGHT_YEAR = 2026;

/** Support / contact — marketing, auth, error, and billing surfaces. */
export const SUPPORT_EMAIL = "kaiav@edenobservability.com";

/** Canonical OpenAI-compatible gateway base URL (production). */
export const GATEWAY_URL = "https://api.edenobservability.com/gateway/v1";

/** Free-tier credit caps — 100 credits ≈ $1 Eden COGS (see plan_tiers.py). */
export const CREDITS_PER_USD = 100;
export const FREE_TIER_CREDITS_SOFT = 8_000; // ≈ $80
export const FREE_TIER_CREDITS_HARD = 10_000; // ≈ $100
export const FREE_TIER_CAP_USD = FREE_TIER_CREDITS_HARD / CREDITS_PER_USD;

/** @deprecated Use FREE_TIER_CAP_USD — personal and org share the same ~$100 credit pool. */
export const FREE_TIER_PERSONAL_CAP_USD = FREE_TIER_CAP_USD;
/** @deprecated Use FREE_TIER_CAP_USD */
export const FREE_TIER_ORG_CAP_USD = FREE_TIER_CAP_USD;

/** Short free-tier line for hero KPIs and compact UI. */
export const FREE_TIER_CAP_SHORT = `${FREE_TIER_CREDITS_HARD.toLocaleString()} credits / mo (≈ $${FREE_TIER_CAP_USD})`;

/** Full free-tier marketing sentence — landing, pricing, CTA. */
export const FREE_TIER_TAGLINE = `Free during public beta · ${FREE_TIER_CAP_SHORT} · No credit card.`;

/** Sales contact — used by billing plan cards + Enterprise pricing CTA. */
export const SALES_EMAIL = "kaiav@edenobservability.com";

/** Canonical public site. */
export const SITE_URL = "https://edenobservability.com";

/** Public Docusaurus docs site (hosted separately from the portal). */
export const DOCS_URL = "https://docs.edenobservability.com";

/** 5-minute quickstart on the docs site (product tour finish CTA). */
export const DOCS_QUICKSTART_URL = `${DOCS_URL}/quickstart`;

/** Maximum number of items the command palette tracks in localStorage. */
export const COMMAND_PALETTE_RECENT_LIMIT = 5;

/** localStorage key for command-palette recent routes. */
export const COMMAND_PALETTE_RECENT_KEY = "eden.recent_routes";

/** Auth brand panel health refresh cadence (ms). */
export const HEALTH_REFRESH_INTERVAL_MS = 60_000;
