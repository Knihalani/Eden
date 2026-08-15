// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// F58 — Saved table views are backed by the real saved-searches CRUD
// API. A view stores the current filter/column URL query-string; these
// tests cover listing views for the current page, applying one (URL
// restore), and saving the current view.

const listMock = vi.fn();
const createMock = vi.fn();
const removeMock = vi.fn();
const recordUseMock = vi.fn();

vi.mock("@/lib/api/resources", () => ({
  savedSearchesApi: {
    list: (...a: unknown[]) => listMock(...a),
    create: (...a: unknown[]) => createMock(...a),
    remove: (...a: unknown[]) => removeMock(...a),
    recordUse: (...a: unknown[]) => recordUseMock(...a),
  },
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/traces",
  useSearchParams: () => ({
    get: () => null,
    toString: () => "view=sessions&agent=a1",
  }),
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

import { SavedViewsMenu } from "./saved-views-menu";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const VIEW = {
  id: "sv_1",
  org_id: "org_1",
  owner_id: "u1",
  name: "Failing sessions",
  query_type: "text",
  query: "view=sessions&agent=a1",
  params: { path: "/traces" },
  is_shared: false,
  is_pinned: false,
  tags: ["/traces"],
  last_used_at: null,
  use_count: 0,
  created_at: "",
  updated_at: "",
};

beforeEach(() => {
  listMock.mockReset();
  createMock.mockReset();
  removeMock.mockReset();
  recordUseMock.mockReset();
  replaceMock.mockReset();
  listMock.mockResolvedValue({ searches: [] });
  recordUseMock.mockResolvedValue({ ok: true });
});

describe("SavedViewsMenu (F58)", () => {
  it("lists saved views for the current page and restores URL on apply", async () => {
    listMock.mockImplementation((_org: string, scope: string) =>
      Promise.resolve({ searches: scope === "personal" ? [VIEW] : [] }),
    );
    render(withClient(<SavedViewsMenu />));

    fireEvent.click(screen.getByRole("button", { name: /Views/i }));
    const applyBtn = await screen.findByRole("button", {
      name: "Failing sessions",
    });
    fireEvent.click(applyBtn);

    expect(replaceMock).toHaveBeenCalledWith(
      "/traces?view=sessions&agent=a1",
      { scroll: false },
    );
    await waitFor(() => expect(recordUseMock).toHaveBeenCalledWith("org_1", "sv_1"));
  });

  it("saves the current URL state as a text view", async () => {
    createMock.mockResolvedValue({ ...VIEW, id: "sv_2" });
    render(withClient(<SavedViewsMenu />));

    fireEvent.click(screen.getByRole("button", { name: /Views/i }));
    fireEvent.change(
      await screen.findByPlaceholderText("Save current view…"),
      { target: { value: "My view" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const [orgArg, body] = createMock.mock.calls[0];
    expect(orgArg).toBe("org_1");
    expect(body).toMatchObject({
      name: "My view",
      query_type: "text",
      query: "view=sessions&agent=a1",
      params: { path: "/traces" },
      tags: ["/traces"],
    });
  });
});
