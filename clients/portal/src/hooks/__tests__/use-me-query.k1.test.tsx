// @vitest-environment jsdom
/**
 * K1 — cold portal session must issue exactly one ``/auth/me`` call
 * when AuthProvider + OrgProvider mount together (shared RQ key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMe = vi.fn(async () => ({
  user_id: "user_1",
  email: "a@b.co",
  name: "Ada",
  organizations: [
    {
      id: "org_1",
      name: "Acme",
      slug: "acme",
      role: "org:admin",
      clerk_org_id: "clerk_org_1",
    },
  ],
  current_org_id: "org_1",
}));

vi.mock("@/lib/api/auth-client", () => ({
  api: { getMe: () => getMe() },
}));

vi.mock("@/lib/api/core", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    detail: string;
    constructor(status: number, message: string, detail?: string) {
      super(message);
      this.status = status;
      this.detail = detail ?? message;
    }
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: true,
    user: {
      id: "user_1",
      emailAddresses: [{ emailAddress: "a@b.co" }],
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    },
  }),
  useOrganization: () => ({
    isLoaded: true,
    organization: { id: "clerk_org_1" },
  }),
  useOrganizationList: () => ({
    isLoaded: true,
    userMemberships: {
      data: [{ organization: { id: "clerk_org_1" }, role: "org:admin" }],
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/use-polling", () => ({
  usePolling: () => {},
}));

import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { OrgProvider, useOrg } from "@/hooks/use-org";

function Probe() {
  const auth = useAuth();
  const org = useOrg();
  return (
    <div>
      <span data-testid="auth-email">{auth.user?.email ?? ""}</span>
      <span data-testid="org-id">{org.currentOrg?.id ?? ""}</span>
    </div>
  );
}

describe("K1 shared /auth/me query", () => {
  let client: QueryClient;

  beforeEach(() => {
    getMe.mockClear();
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60_000 },
      },
    });
  });

  afterEach(() => {
    client.clear();
  });

  it("issues exactly one getMe network call for Auth+Org cold mount", async () => {
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <OrgProvider>
            <Probe />
          </OrgProvider>
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(getMe).toHaveBeenCalledTimes(1);
    });

    // Settle — no second call from the sibling provider.
    await waitFor(() => {
      expect(document.querySelector("[data-testid=org-id]")?.textContent).toBe(
        "org_1",
      );
    });
    expect(getMe).toHaveBeenCalledTimes(1);
  });
});
