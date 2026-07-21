// @vitest-environment node
/**
 * A1 chrome — structural Done-when checks for lazy islands, BudgetTicker
 * interval, notifications signed-in gate, PerformanceObservers, toast memo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("A1 portal chrome Done-when", () => {
  it("P2-phase1: chrome uses dynamic() for ChatSidebar, CommandPalette, OnboardingOverlay", () => {
    // ChatSidebar peeled into AiRailHost; palette/overlay stay on orchestrator.
    const chrome = read("app/(portal)/portal-chrome.tsx");
    const aiRail = read("components/portal-chrome/AiRailHost.tsx");
    const peeled = `${chrome}\n${aiRail}`;
    expect(peeled).toMatch(/dynamic\(/);
    expect(aiRail).toMatch(/ChatSidebar/);
    expect(chrome).toMatch(/CommandPalette/);
    expect(chrome).toMatch(/OnboardingOverlay/);
    expect(peeled).not.toMatch(
      /import\s+\{\s*ChatSidebar\s*\}\s+from\s+["']@\/components\/ai-insights\/ChatSidebar["']/,
    );
    expect(peeled).not.toMatch(
      /import\s+\{\s*CommandPalette\s*\}\s+from\s+["']@\/components\/portal-os\/CommandPalette["']/,
    );
    expect(peeled).not.toMatch(
      /import\s+\{\s*OnboardingOverlay\s*\}\s+from\s+["']@\/components\/onboarding\/OnboardingOverlay["']/,
    );
  });

  it("P2-phase2: portal layout is RSC shell wrapping PortalProviders + PortalChrome", () => {
    const layout = read("app/(portal)/layout.tsx");
    expect(layout).not.toMatch(/^["']use client["']/m);
    expect(layout).toMatch(/PortalProviders/);
    expect(layout).toMatch(/PortalChrome/);
    const root = read("app/layout.tsx");
    expect(root).not.toMatch(/PortalProviders/);
  });

  it("K2: BudgetTicker intervalMs >= 30000", () => {
    const src = read("components/budget-ticker.tsx");
    expect(src).toMatch(/BUDGET_TICKER_INTERVAL_MS\s*=\s*30_000/);
    expect(src).toMatch(/intervalMs:\s*BUDGET_TICKER_INTERVAL_MS/);
    expect(src).not.toMatch(/intervalMs:\s*5_000/);
  });

  it("notifications enabled only when signed-in", () => {
    const src = read("hooks/use-notifications.tsx");
    expect(src).toMatch(/useUser/);
    expect(src).toMatch(/enabled:\s*Boolean\(isLoaded\s*&&\s*isSignedIn\)/);
  });

  it("P8/P9: toast + notifications contexts are memoized/split", () => {
    const toast = read("components/ui/toast.tsx");
    expect(toast).toMatch(/ToastActionsContext/);
    expect(toast).toMatch(/useMemo/);
    const notif = read("hooks/use-notifications.tsx");
    expect(notif).toMatch(/NotificationsActionsContext/);
    expect(notif).toMatch(/useMemo/);
  });

  it("P20: auth brand panel uses usePolling (no raw setInterval)", () => {
    const src = read("components/auth/auth-brand-panel.tsx");
    expect(src).toMatch(/usePolling/);
    expect(src).not.toMatch(/setInterval/);
    expect(src).toMatch(/mapHealthResponse/);
    // Cost: dedicated /api/health skips Clerk auth() on the catch-all proxy.
    expect(src).toMatch(/["']\/api\/health["']/);
    expect(src).not.toMatch(/\/api\/proxy\/health/);
  });

  it("W1-E: chrome Sign in only for session auth errors", () => {
    const chrome = read("app/(portal)/portal-chrome.tsx");
    expect(chrome).toMatch(/authErrorKind/);
    expect(chrome).toMatch(/isSessionAuthError/);
    expect(chrome).toMatch(/authErrorKind === ["']session["']/);
    const org = read("hooks/use-org.tsx");
    expect(org).toMatch(/authErrorKind/);
    expect(org).toMatch(/classifyOrgLoadError/);
  });

  it("React #310: chrome banner useEffect is above loading early returns", () => {
    // Banner attr effect peeled into usePortalChromeBannerAttr; call must
    // stay above loading early returns in the orchestrator.
    const effects = read("hooks/use-portal-chrome-effects.ts");
    expect(effects).toMatch(/export function usePortalChromeBannerAttr/);
    expect(effects).toMatch(/CHROME_BANNER_ATTR/);

    const chrome = read("app/(portal)/portal-chrome.tsx");
    const start = chrome.indexOf("function PortalLayoutContent");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = chrome.slice(start);
    const callIdx = body.indexOf("usePortalChromeBannerAttr");
    const earlyIdx = body.indexOf("if (loading && !isKnownPortalPath");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(earlyIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeLessThan(earlyIdx);
  });

  it("P35: PerformanceObservers gated to development", () => {
    // Runtime chrome no longer ships web-vitals observers (load bloat cut).
    // CI measure script retains PerformanceObservers for budgets.
    const chrome = read("app/(portal)/portal-chrome.tsx");
    const effects = read("hooks/use-portal-chrome-effects.ts");
    expect(chrome).not.toMatch(/PerformanceObserver/);
    expect(effects).not.toMatch(/PerformanceObserver/);
    const measure = readFileSync(
      join(root, "../scripts/measure-web-vitals.mjs"),
      "utf8",
    );
    expect(measure).toMatch(/PerformanceObserver/);
  });

  it("K1: shared ME_QUERY_KEY exists", () => {
    const src = read("hooks/use-me-query.ts");
    expect(src).toMatch(/ME_QUERY_KEY\s*=\s*\["auth",\s*"me"\]/);
  });

  it("P25: proxy skips intl on portal; keeps Clerk protect; root skips messages", () => {
    const proxy = read("proxy.ts");
    expect(proxy).toMatch(/function shouldRunIntl/);
    expect(proxy).toMatch(/isKnownPortalPath/);
    expect(proxy).toMatch(/x-eden-pathname/);
    expect(proxy).toMatch(/auth\.protect/);
    expect(proxy).toMatch(/avif\|mp4\|webm\|wasm\|map/);
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/skipIntlMessages/);
    expect(layout).toMatch(/x-eden-pathname/);
    expect(layout).toMatch(/getMessages/);
  });
});
