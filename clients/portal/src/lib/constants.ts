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

/** Support contact — appears in marketing error page + billing "Contact sales". */
export const SUPPORT_EMAIL = "support@eden.dev";

/** Sales contact — used by billing plan cards. */
export const SALES_EMAIL = "sales@eden.dev";

/** External status page (real URL). */
export const STATUS_PAGE_URL = "https://status.edenobservability.com";

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
