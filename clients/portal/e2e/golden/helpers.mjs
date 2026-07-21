/**
 * F85 golden-path helpers — shared Playwright utilities.
 *
 * Auth-state domain requirements (e2e/.auth-state.json):
 *   - Cookies / origins must match the host you hit via BASE / BASE_URL.
 *   - Local seed (seed-auth.mjs against 127.0.0.1 / localhost + pk_test Clerk)
 *     yields cookies for localhost / *.clerk.accounts.dev — NOT valid on
 *     https://edenobservability.com (prod will redirect to /sign-in).
 *   - Prod audits: capture storageState with wait-for-signin.mjs (or Playwright
 *     codegen --channel=chrome) against the same BASE. Do not invent or hardcode
 *     production credentials in this repo; do not reuse local auth-state on prod.
 *   - See e2e/README-auth.md for required env + signed-in flows.
 *
 * Exit honesty:
 *   GOLDEN_CI=1 → missing/mismatched auth state exits 1 (never silent pass).
 *   Path failures exit non-zero unless GOLDEN_ALLOW_FAIL=1 (local only).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE = (process.env.BASE_URL || process.env.BASE || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
export const FIXTURE_TRACE = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/traces/sample-redacted.json"), "utf8"),
);

const STATE_PATH = resolve(__dirname, "../.auth-state.json");

/** True for localhost / 127.0.0.1 (local portal + seed-auth). */
export function isLocalHost(hostname) {
  return /^(localhost|127\.0\.0\.1)$/i.test(hostname || "");
}

/**
 * Collect hostnames from Playwright storageState origins + cookie domains.
 * Cookie domains may include a leading dot (e.g. `.example.com`).
 */
export function collectAuthStateHosts(state) {
  const hosts = new Set();
  const origins = Array.isArray(state?.origins) ? state.origins : [];
  for (const o of origins) {
    const raw = typeof o === "string" ? o : o?.origin;
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname);
    } catch {
      /* ignore bad origin */
    }
  }
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  for (const c of cookies) {
    if (typeof c?.domain === "string" && c.domain.trim()) {
      hosts.add(c.domain.replace(/^\./, "").toLowerCase());
    }
  }
  return [...hosts];
}

/**
 * Whether storageState hosts are compatible with the BASE hostname.
 * localhost ↔ 127.0.0.1 count as a local pair. Clerk *.accounts.dev alone
 * never matches a production apex host.
 */
export function authStateMatchesBase(state, baseUrl = BASE) {
  let baseHost = "";
  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return { ok: false, baseHost: "", hosts: [], reason: "invalid-base" };
  }
  const hosts = collectAuthStateHosts(state).map((h) => h.toLowerCase());
  if (hosts.length === 0) {
    return { ok: false, baseHost, hosts, reason: "no-hosts" };
  }

  const hostMatch = hosts.some(
    (h) =>
      h === baseHost ||
      h === `www.${baseHost}` ||
      baseHost === `www.${h}` ||
      baseHost.endsWith(`.${h}`),
  );
  const localPair = isLocalHost(baseHost) && hosts.some((h) => isLocalHost(h));
  if (hostMatch || localPair) {
    return { ok: true, baseHost, hosts, reason: localPair ? "local-pair" : "host-match" };
  }
  return { ok: false, baseHost, hosts, reason: "host-mismatch" };
}

/**
 * Returns the parsed storageState JSON, or null if not found.
 * Exits non-zero if GOLDEN_CI=1 and auth state is missing, unparsable, or
 * domain-mismatched for BASE — never silently pass without usable auth in CI.
 */
export function loadAuthState() {
  if (!existsSync(STATE_PATH)) {
    if (process.env.GOLDEN_CI === "1") {
      console.error(
        "[golden] FATAL: GOLDEN_CI=1 but e2e/.auth-state.json not found.\n" +
          "  Run seed-auth.mjs (local) or wait-for-signin.mjs (prod) before golden-paths.\n" +
          "  Auth cookies must match BASE origin — see helpers.mjs header comments.\n" +
          "  Required env vars for local seed-auth: CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      );
      process.exit(1);
    }
    console.warn("[golden] WARNING: no e2e/.auth-state.json found — running unauthenticated");
    return null;
  }
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    const match = authStateMatchesBase(state, BASE);
    if (!match.ok) {
      const msg =
        `[golden] auth-state hosts (${match.hosts.join(", ") || "none"}) ` +
        `do not match BASE host (${match.baseHost || "invalid"}).\n` +
        "  Re-seed against the same origin as BASE (wait-for-signin.mjs for prod).\n" +
        "  Local Clerk test cookies are not valid on edenobservability.com.";
      if (process.env.GOLDEN_CI === "1") {
        console.error(`[golden] FATAL: ${msg}`);
        process.exit(1);
      }
      console.warn(`[golden] WARNING: ${msg}`);
    }
    return state;
  } catch (e) {
    console.error("[golden] ERROR: could not parse e2e/.auth-state.json:", String(e).slice(0, 120));
    if (process.env.GOLDEN_CI === "1") process.exit(1);
    return null;
  }
}

export async function screenshotStep(page, name) {
  const dir = process.env.GOLDEN_SCREENSHOT_DIR || "e2e/golden/screenshots";
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true }).catch(() => {});
}

export async function assertNoCrash(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/Application error|Unhandled Runtime Error/i.test(body)) {
    throw new Error("Portal crashed — application error visible");
  }
}

/**
 * Dismiss cookie / product-tour overlays that hide headings on deep routes.
 */
export async function dismissTransientOverlays(page) {
  for (const label of ["Accept", "Decline", "Skip", "Skip tour"]) {
    const btn = page.getByRole("button", { name: label }).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 1500 }).catch(() => {});
    }
  }
  const skipLink = page.getByRole("link", { name: /^Skip$/i }).first();
  if ((await skipLink.count()) > 0 && (await skipLink.isVisible().catch(() => false))) {
    await skipLink.click({ timeout: 1500 }).catch(() => {});
  }
}

/** Wait until portal-chrome leaves the “Signing you in” loading shell. */
export async function waitForAuthHydrated(page, { timeout = 45_000 } = {}) {
  const signingIn = page.getByText("Signing you in", { exact: false });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const stuck =
      (await signingIn.count().catch(() => 0)) > 0 &&
      (await signingIn.first().isVisible().catch(() => false));
    if (!stuck) return;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Auth chrome stuck on “Signing you in” (url: ${page.url()}). ` +
      "Clerk session may not have hydrated — re-run seed-auth or setupClerkTestingToken.",
  );
}

/**
 * Asserts the authenticated portal shell is visible: at least one sidebar
 * navigation link rendered. When Clerk auth is not working the browser is
 * redirected to /sign-in and no nav links exist.
 */
export async function assertAuthShell(page) {
  await waitForAuthHydrated(page);
  await dismissTransientOverlays(page);
  const navLinks = page.locator("nav a[href], aside a[href]");
  const signingIn = page.getByText("Signing you in", { exact: false });
  try {
    await navLinks.first().waitFor({ state: "attached", timeout: 30_000 });
  } catch {
    const url = page.url();
    const stillSigningIn = (await signingIn.count().catch(() => 0)) > 0;
    throw new Error(
      `Auth shell not visible — no portal nav links (url: ${url}).\n` +
        (stillSigningIn
          ? "  Portal chrome stuck on “Signing you in” (Clerk session may not have hydrated).\n"
          : "") +
        "  storageState may be expired or cookies may not match BASE.\n" +
        "  Re-run seed-auth.mjs (local) or wait-for-signin.mjs (prod).",
    );
  }
  const count = await navLinks.count();
  if (count === 0) {
    const url = page.url();
    throw new Error(
      `Auth shell not visible — no portal nav links (url: ${url}).\n` +
        "  storageState may be expired or cookies may not match BASE.\n" +
        "  Re-run seed-auth.mjs (local) or wait-for-signin.mjs (prod).",
    );
  }
}

/**
 * Waits for the page heading (h1) or a known empty-state/no-org text, then
 * returns the heading text (or null if only an empty/no-org state is found).
 * Throws if neither resolves within the timeout, indicating a render failure.
 */
export async function assertPageLoaded(page, { timeout = 15_000 } = {}) {
  await dismissTransientOverlays(page).catch(() => {});
  const heading = page.locator("h1").first();
  const noOrg = page
    .locator('text="Finish setup"')
    .or(page.locator('text="No organisation"'))
    .or(page.locator('text="No workspace yet"'))
    .or(page.locator('text="Syncing your workspace"'));
  const emptyState = page.locator('[data-testid="empty-state"], [data-testid="no-data"]');

  try {
    await Promise.race([
      heading.waitFor({ state: "visible", timeout }),
      noOrg.waitFor({ state: "visible", timeout }),
      emptyState.waitFor({ state: "visible", timeout }),
    ]);
    const h1Text = await heading.textContent().catch(() => null);
    return h1Text;
  } catch {
    await assertNoCrash(page);
    const url = page.url();
    if (/sign-in|login/.test(url)) {
      throw new Error(`Page redirected to auth (${url}) — storageState may have expired`);
    }
    return null;
  }
}
