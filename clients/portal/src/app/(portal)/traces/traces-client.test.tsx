import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceFixture } from "@/lab/fixtures/traces";

// Regression coverage for a race condition in the "default selection"
// effect (~line 490 in traces-client.tsx): its dependency array was
// only `[traces]`, so it never reconsidered the URL `?id=` param once
// a selection had already been made. Concretely: if `?id=` pointed at
// a run that hadn't loaded into `traces` yet, the initial-state
// fallback picked `traces[0]` instead — and once the real matching
// row *did* arrive (traces updated to a new array), the effect's own
// guard (`if (selectedId || traces.length === 0) return`) bailed out
// because `selectedId` was already (wrongly) non-empty, so the
// selection never caught up with the URL even though the row it
// pointed at was now available.
//
// The primary test below holds `?id=` fixed and changes only the
// `traces` array reference to reproduce that exact sequence. A second
// test covers the simpler sibling path — `?id=` itself changing to a
// row that's already loaded — which the fix also has to keep working.

// -- Controllable `next/navigation` mocks -----------------------------
// A mutable object backs `useSearchParams()` so a test can simulate the
// URL's `id` param changing (or staying fixed) independently of the
// `traces` array reference.
let mockParams: Record<string, string | undefined> = { id: "t1" };

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => mockParams[key] ?? null,
    toString: () =>
      new URLSearchParams(
        Object.entries(mockParams).filter(
          (entry): entry is [string, string] => entry[1] != null,
        ),
      ).toString(),
  }),
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
  }),
  usePathname: () => "/traces",
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

function makeTrace(id: string, name: string, startedAt: string): TraceFixture {
  return {
    id,
    agentId: "agent_1",
    name,
    status: "ok",
    startedAt,
    durationMs: 100,
    tokens: 10,
    costUsd: 0.01,
    severity: "none",
    signals: { title: "", body: "" },
    steps: [],
  };
}

const T1 = makeTrace("t1", "Run one", "2026-07-27T00:00:00Z");
const T2 = makeTrace("t2", "Run two", "2026-07-27T00:01:00Z");

// Mutable "traces" the `useOrgQuery` mock hands back — reassigning it
// to a *new* array is how a test simulates a real React Query refetch
// landing (a new array reference); leaving it untouched across a
// rerender is how a test simulates the query cache *not* refetching
// (same array reference) while only the URL changes.
let mockTraces: TraceFixture[] = [T1];

vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: (key: readonly unknown[]) => {
    const resource = key[1];
    if (resource === "traces") {
      return {
        data: mockTraces,
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (resource === "sessions" || resource === "agents") {
      return {
        data: [],
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    // traceDetail (and anything else) — no async detail payload needed
    // for this test; the list row already carries `steps: []`.
    return {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/lib/api/portal", () => ({
  portalApi: {
    traces: vi.fn(),
    agents: vi.fn(),
    sessions: vi.fn(),
    traceDetail: vi.fn(),
  },
}));

// SavedViewsMenu uses React Query (useQueryClient) and is covered by its own
// test with a provider. These tests are about `?id=` selection, so stub it to
// avoid needing a QueryClientProvider in this focused harness.
vi.mock("@/components/portal/saved-views-menu", () => ({
  SavedViewsMenu: () => null,
}));

vi.mock("@/lab/annotate-trace-dialog", () => ({
  AnnotateTraceDialog: ({ open }: { open: boolean }) =>
    open ? (
      <div role="dialog" aria-label="Annotate trace">
        Annotate dialog
      </div>
    ) : null,
}));

const { default: TracesClient } = await import("./traces-client");

afterEach(() => {
  vi.clearAllMocks();
  mockParams = { id: "t1" };
  mockTraces = [T1];
});

function activeAttr(name: RegExp): string | null {
  return screen.getByRole("button", { name }).getAttribute("data-active");
}

describe("traces-client selection vs. URL `id` param", () => {
  it("selects the row matching the initial `?id=` param", () => {
    mockParams = { id: "t1" };
    mockTraces = [T1, T2];
    render(<TracesClient />);

    expect(activeAttr(/Run one/)).toBe("true");
    expect(activeAttr(/Run two/)).toBe("false");
  });

  it("catches up to `?id=` once the matching row arrives, even though a (different) selection was already made", () => {
    // `?id=t2` is requested up front, but `t2` hasn't loaded into
    // `traces` yet — the initial-state fallback lands on `t1` instead.
    mockParams = { id: "t2" };
    mockTraces = [T1];
    const { rerender } = render(<TracesClient />);

    expect(activeAttr(/Run one/)).toBe("true");

    // The traces query resolves with the full list — a *new* array
    // reference — while `?id=` stays exactly "t2" throughout. Without
    // `paramId` in the effect's deps (and without correcting an
    // already-non-empty `selectedId`), this update was silently
    // dropped and the page stayed stuck on "t1".
    mockTraces = [T1, T2];
    rerender(<TracesClient />);

    expect(activeAttr(/Run two/)).toBe("true");
    expect(activeAttr(/Run one/)).toBe("false");
  });

  it("follows `?id=` changing to an already-loaded row, without the traces array reference changing", () => {
    mockParams = { id: "t1" };
    mockTraces = [T1, T2];
    const { rerender } = render(<TracesClient />);

    expect(activeAttr(/Run one/)).toBe("true");

    // Same `traces` array instance as before — only the URL changes.
    mockParams = { id: "t2" };
    rerender(<TracesClient />);

    expect(activeAttr(/Run two/)).toBe("true");
    expect(activeAttr(/Run one/)).toBe("false");
  });
});

describe("traces-client selection vs. an in-flight manual click", () => {
  // Regression coverage for a narrower race reopened by the fix above.
  // `selectTrace` sets `selectedId` synchronously, but its `patchQuery`
  // call (`router.replace`, mocked as a no-op here) resolves the URL
  // asynchronously — so `?id=` (`paramId`) still names the *previous*
  // row for a beat after a click. The URL-sync effect's deps are
  // `[traces, paramId]`: if `traces` gets a new array reference from
  // something unrelated to the click (e.g. `PortalCatalogSync`
  // refetching the same query key) during that gap, the effect
  // re-fires with the stale `paramId` — and, without a guard, would
  // see `matched !== selectedId` and revert the fresh click straight
  // back to the row `paramId` still names.
  it("does not revert a just-clicked selection when `traces` gets a new array reference before the URL catches up", () => {
    mockParams = { id: "t1" };
    mockTraces = [T1, T2];
    const { rerender } = render(<TracesClient />);

    expect(activeAttr(/Run one/)).toBe("true");

    // Manual click: `selectTrace("t2")` runs, setting `selectedId`
    // synchronously. `patchQuery` → the mocked `router.replace` is a
    // no-op, so `mockParams.id` deliberately stays "t1" — simulating
    // the real `router.replace` navigation not having resolved yet.
    fireEvent.click(screen.getByRole("button", { name: /Run two/ }));
    expect(activeAttr(/Run two/)).toBe("true");

    // Simulate an unrelated cache update (PortalCatalogSync patching
    // the shared `traces` query) landing a *new* array reference with
    // the same underlying rows, while the URL (`mockParams.id`) is
    // still unresolved at "t1". The component stays mounted (`rerender`,
    // not a fresh `render`) so `selectedId` state from the click above
    // survives, exactly like a real re-render triggered by the query
    // cache update.
    mockTraces = [{ ...T1 }, { ...T2 }];
    rerender(<TracesClient />);

    expect(activeAttr(/Run two/)).toBe("true");
    expect(activeAttr(/Run one/)).toBe("false");
  });
});

describe("FEAT-115 annotate action", () => {
  it("opens AnnotateTraceDialog from the trace detail action bar", () => {
    mockParams = { id: "t1" };
    mockTraces = [T1];
    render(<TracesClient />);

    fireEvent.click(screen.getByRole("button", { name: "Annotate" }));
    expect(screen.getByRole("dialog", { name: "Annotate trace" })).toBeTruthy();
  });
});

describe("Wave 10 action-bar mounts", () => {
  it("shows 'vs prev' and pre-fills TraceDiffDialog with the previous same-agent run", () => {
    // t2 is the newest same-agent run; its chronologically-previous
    // same-agent run is t1 — the "vs prev" button must prefill that id.
    mockParams = { id: "t2" };
    mockTraces = [T1, T2];
    render(<TracesClient />);

    const vsPrev = screen.getByRole("button", { name: /vs prev/ });
    expect(vsPrev).toBeTruthy();
    fireEvent.click(vsPrev);

    const dialog = screen.getByRole("dialog", { name: "Compare runs" });
    expect(dialog).toBeTruthy();
    expect(
      (screen.getByLabelText("Other run id") as HTMLInputElement).value,
    ).toBe("t1");
  });
});
