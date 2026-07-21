/**
 * Home Shell Wave 2 — Cookie consent 2A.
 * After Accept/Decline: no fixed preferences pill; Settings/footer reopen.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COOKIE_CONSENT_KEY,
  openCookiePreferences,
} from "@/lib/analytics";

const applyAnalyticsConsent = vi.fn();
const bootAnalyticsFromStoredConsent = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("@/lib/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analytics")>(
    "@/lib/analytics",
  );
  return {
    ...actual,
    applyAnalyticsConsent: (...args: unknown[]) =>
      applyAnalyticsConsent(...args),
    bootAnalyticsFromStoredConsent: (...args: unknown[]) =>
      bootAnalyticsFromStoredConsent(...args),
  };
});

vi.mock("@/lib/overlay-defer", () => ({
  CHROME_BANNER_ATTR: "data-chrome-banner",
  ERROR_STATE_ATTR: "data-error-state",
  shouldDeferBlockingOverlays: () => false,
}));

vi.mock("@/lib/auth-redirect", () => ({
  isAuthPath: () => false,
}));

import { CookieConsent } from "@/components/cookie-consent";
import { CookiePreferencesRow } from "@/components/settings/cookie-preferences-row";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string) =>
  readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("Home Shell W2 — cookie 2A source contracts", () => {
  it("hasChoice path returns null — no post-choice preferences pill", () => {
    const src = read("components/cookie-consent.tsx");
    expect(src).toMatch(
      /if\s*\(\s*ready\s*&&\s*hasChoice\s*&&\s*!visible\s*\)\s*return\s*null/,
    );
    expect(src).not.toMatch(/Cookie preferences[\s\S]*?onClick=\{openPreferences\}/);
    expect(src).not.toContain("Compact re-open control after a choice");
    expect(src).toContain("OPEN_COOKIE_PREFERENCES_EVENT");
    expect(src).toContain("bootAnalyticsFromStoredConsent");
    expect(src).toContain("shouldDeferBlockingOverlays");
    expect(src).toContain('"0px"');
  });

  it("Settings row + footer call openCookiePreferences", () => {
    const row = read("components/settings/cookie-preferences-row.tsx");
    const footer = read(
      "app/(marketing)/_components/MarketingFooter.tsx",
    );
    const account = read(
      "app/(portal)/settings/_components/account-panel.tsx",
    );
    expect(row).toContain("openCookiePreferences");
    expect(row).toContain("data-testid=\"cookie-preferences-row\"");
    expect(account).toContain("CookiePreferencesRow");
    expect(footer).toContain("openCookiePreferences");
    expect(footer).toContain("footer.cookiePreferences");
  });
});

describe("Home Shell W2 — Accept hides preference pill; Settings withdraws", () => {
  beforeEach(() => {
    applyAnalyticsConsent.mockClear();
    bootAnalyticsFromStoredConsent.mockClear();
    window.localStorage.clear();
    document.documentElement.style.removeProperty("--cookie-banner-offset");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    document.documentElement.style.removeProperty("--cookie-banner-offset");
  });

  it("Accept → no Cookie preferences pill in DOM; offset cleared", async () => {
    render(<CookieConsent />);
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    const accept = await screen.findByRole("button", { name: "Accept" });
    fireEvent.click(accept);

    expect(applyAnalyticsConsent).toHaveBeenCalledWith("accepted");
    expect(window.localStorage.getItem(COOKIE_CONSENT_KEY)).toBe("accepted");
    expect(
      screen.queryByRole("button", { name: "Cookie preferences" }),
    ).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Cookie consent" })).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--cookie-banner-offset"),
    ).toBe("0px");
  });

  it("Settings Manage cookies reopens dialog; Decline withdraws", async () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, "accepted");
    render(
      <>
        <CookieConsent />
        <CookiePreferencesRow />
      </>,
    );

    await waitFor(() => {
      expect(bootAnalyticsFromStoredConsent).toHaveBeenCalled();
    });

    expect(screen.queryByRole("dialog", { name: "Cookie consent" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Cookie preferences" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Manage cookies" }));

    expect(
      await screen.findByRole("dialog", { name: "Cookie consent" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(applyAnalyticsConsent).toHaveBeenCalledWith("declined");
    expect(window.localStorage.getItem(COOKIE_CONSENT_KEY)).toBe("declined");
    expect(screen.queryByRole("dialog", { name: "Cookie consent" })).toBeNull();
  });

  it("openCookiePreferences event reopens after prior choice", async () => {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, "declined");
    render(<CookieConsent />);

    await waitFor(() => {
      expect(bootAnalyticsFromStoredConsent).toHaveBeenCalled();
    });

    act(() => {
      openCookiePreferences();
    });

    expect(
      await screen.findByRole("dialog", { name: "Cookie consent" }),
    ).toBeInTheDocument();
  });
});
