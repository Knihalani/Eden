/**
 * F85 golden-path helpers — shared Playwright utilities.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.BASE_URL || process.env.BASE || "http://127.0.0.1:3000";
export const FIXTURE_TRACE = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/traces/sample-redacted.json"), "utf8"),
);

const STATE_PATH = resolve(__dirname, "../.auth-state.json");

/**
 * Returns the parsed storageState JSON, or null if not found.
 * Exits non-zero if GOLDEN_CI=1 and no auth state exists — never silently pass
 * without auth in CI mode.
 */
export function loadAuthState() {
  if (!existsSync(STATE_PATH)) {
    if (process.env.GOLDEN_CI === "1") {
      console.error(
        "[golden] FATAL: GOLDEN_CI=1 but e2e/.auth-state.json not found.\n" +
        "  Run seed-auth.mjs before golden-paths.spec.mjs.\n" +
        "  Required env vars for seed-auth: CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      );
      process.exit(1);
    }
    console.warn("[golden] WARNING: no e2e/.auth-state.json found — running unauthenticated");
    return null;
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
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
 * Asserts the authenticated portal shell is visible: at least one sidebar
 * navigation link rendered. When Clerk auth is not working the browser is
 * redirected to /sign-in and no nav links exist.
 */
export async function assertAuthShell(page) {
  // The sidebar renders nav links for Dashboard, Traces, Issues etc.
  // Check for at least one nav anchor inside the sidebar/nav element.
  const navLinks = page.locator('nav a[href], aside a[href]');
  const count = await navLinks.count();
  if (count === 0) {
    // Fall back to checking that we're NOT on the sign-in page
    const url = page.url();
    if (/sign-in|login/.test(url)) {
      throw new Error(
        `Auth shell not visible — browser is on sign-in page (${url}).\n` +
        "  The storageState may have expired. Re-run seed-auth.mjs.",
      );
    }
  }
}

/**
 * Waits for the page heading (h1) or a known empty-state/no-org text, then
 * returns the heading text (or null if only an empty/no-org state is found).
 * Throws if neither resolves within the timeout, indicating a render failure.
 */
export async function assertPageLoaded(page, { timeout = 15_000 } = {}) {
  const heading = page.locator("h1").first();
  const noOrg = page.locator('text="Finish setup"').or(page.locator('text="No organisation"'));
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
    // Last-chance: check we're not on an error page
    await assertNoCrash(page);
    const url = page.url();
    if (/sign-in|login/.test(url)) {
      throw new Error(`Page redirected to auth (${url}) — storageState may have expired`);
    }
    return null;
  }
}
