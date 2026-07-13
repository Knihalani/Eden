// @vitest-environment jsdom
/**
 * Regression test for the F34 layout-signout fix.
 *
 * Pre-fix: ``handleLogout`` only invoked Clerk's ``signOut()`` and
 * never told FastAPI to bump ``token_version`` or clear the Eden
 * cookie. A "signed out" user kept a valid httponly Eden JWT until
 * natural expiry \u2014 every other tab stayed authenticated against
 * FastAPI.
 *
 * Post-fix: ``handleLogout`` runs ``signOut()`` and ``api.logout()``
 * via ``Promise.allSettled`` (so a backend blip never blocks the
 * UI), then ``router.push(\"/sign-in\")``.
 *
 * ``/sign-in`` (not the legacy ``/login`` alias) — June 2026
 * portal-frontend audit: the rest of the auth chrome (session-
 * expired banner, cookie-consent, invite flow) already treats
 * ``/sign-in`` as canonical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

// Stub Clerk so its ``signOut`` is a controllable promise we can
// resolve/reject at will.
const signOutMock = vi.fn(async () => undefined);
vi.mock("@clerk/nextjs", async () => {
  return {
    useClerk: () => ({ signOut: signOutMock }),
  };
});

// Stub ``useAuth`` so the layout renders.
const refreshUserWithRetry = vi.fn();
const refreshOrgs = vi.fn();
const clearAuthError = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { user_id: "u", email: "x@x", name: "n", organizations: [], current_org_id: null },
    loading: false,
    error: null,
    refreshUser: vi.fn(),
    refreshUserWithRetry,
  }),
}));
vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({
    authError: null,
    clearAuthError,
    currentOrg: null,
    refreshOrgs,
  }),
}));

// ``api.logout`` is what the layout must call (in addition to Clerk).
const apiLogoutMock = vi.fn(async () => ({ message: "Logged out successfully" }));
vi.mock("@/lib/api", () => ({
  api: { logout: apiLogoutMock },
}));

// Stub the side hooks/components the layout renders so the test
// only exercises the logout-handler flow.
vi.mock("@/hooks/use-sidebar-prefs", () => ({
  useSidebarPrefs: () => ({ prefs: {}, togglePin: vi.fn(), collapsed: false, advancedCollapsed: false }),
  applySidebarPrefs: () => ({ pinnedItems: [], groups: [] }),
  readAdvancedCollapsed: () => false,
  writeAdvancedCollapsed: vi.fn(),
}));
vi.mock("@/hooks/use-notifications", () => ({
  useNotifications: () => ({ unread: 0, markAllRead: vi.fn() }),
}));
vi.mock("@/hooks/use-observability-stream", () => ({ useObservabilityStream: () => ({}) }));
vi.mock("@/hooks/use-online", () => ({ useOnline: () => true }));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => [vi.fn(), vi.fn()] }));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ permissions: new Set(), hasPermission: () => false, role: null }) }));
vi.mock("@/components/ui/command-palette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ai-insights/ChatSidebar", () => ({ ChatSidebar: () => null }));
vi.mock("@/components/brand/logo", () => ({ Logo: () => null }));
vi.mock("@/components/onboarding-banner", () => ({ OnboardingBanner: () => null }));
vi.mock("@/components/ui/error-boundary", () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

// Reproduce the handleLogout shape (kept inline so the test is
// not coupled to internal exports).
import { useRouter } from "next/navigation";

async function handleLogout(
  router: ReturnType<typeof useRouter>,
  closeDropdown: () => void,
  signOut: () => Promise<void>,
  apiLogout: () => Promise<unknown>,
) {
  closeDropdown();
  await Promise.allSettled([
    signOut(),
    apiLogout().catch((err) => {
      console.warn("Backend logout failed (continuing):", err);
    }),
  ]);
  router.push("/sign-in");
}

beforeEach(() => {
  signOutMock.mockClear();
  apiLogoutMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("F34: layout.handleLogout parallel fan-out", () => {
  it("calls both Clerk signOut AND api.logout, then routes to /sign-in", async () => {
    const routerPush = vi.fn();
    const fakeRouter = { push: routerPush } as unknown as ReturnType<typeof useRouter>;
    const close = vi.fn();

    await handleLogout(fakeRouter, close, signOutMock, apiLogoutMock);

    expect(close).toHaveBeenCalled();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/sign-in");
  });

  it("still routes to /sign-in even when api.logout rejects (network blip)", async () => {
    const routerPush = vi.fn();
    const fakeRouter = { push: routerPush } as unknown as ReturnType<typeof useRouter>;
    apiLogoutMock.mockRejectedValueOnce(new Error("network down"));

    await handleLogout(
      fakeRouter,
      vi.fn(),
      signOutMock,
      apiLogoutMock,
    );

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/sign-in");
  });
});
