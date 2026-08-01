import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression coverage for: a local variable literally named `window`
// (`const window = WINDOW_OPTIONS[windowIdx] ?? WINDOW_OPTIONS[0]`) used to
// shadow the global `window` object for the rest of GatewayClient. See
// gateway-client.tsx.

const downloadCsv = vi.fn();
const downloadPng = vi.fn();
vi.mock("@/lib/export", () => ({
  downloadCsv: (...args: unknown[]) => downloadCsv(...args),
  downloadPng: (...args: unknown[]) => downloadPng(...args),
}));

const overviewFn = vi.fn();
vi.mock("@/lib/api/gateway", () => ({
  gatewayApi: { overview: (...args: unknown[]) => overviewFn(...args) },
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

type OverviewData = {
  total_cost_usd: number;
  events: number;
  untagged_events: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_savings_usd: number;
  delta_pct: number | null;
  by_model: Array<{ key: string; cost_usd: number; events: number; tokens: number }>;
  by_feature: Array<{ key: string; cost_usd: number; events: number; tokens: number }>;
  by_agent: Array<{ key: string; cost_usd: number; events: number; tokens: number }>;
  by_day: Array<{ day: string; cost_usd: number; events: number; tokens: number }>;
  models: unknown[];
  providers: unknown[];
  cache: null;
};

function makeData(hours: number): OverviewData {
  return {
    total_cost_usd: hours,
    events: 10,
    untagged_events: 0,
    total_tokens: 1000,
    input_tokens: 600,
    output_tokens: 400,
    cache_savings_usd: 0,
    delta_pct: null,
    by_model: [{ key: "gpt-4", cost_usd: hours, events: 10, tokens: 1000 }],
    by_feature: [],
    by_agent: [],
    by_day: [{ day: "2026-07-01", cost_usd: hours, events: 10, tokens: 1000 }],
    models: [],
    providers: [],
    cache: null,
  };
}

// useOrgQuery is invoked once per render with the *current* query key, whose
// third element is the window's `hours` — mirror that back as `data` so
// assertions can tell which window is currently wired through the component.
vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: (key: readonly unknown[]) => {
    const hours = (key[key.length - 1] as number) ?? 24;
    return {
      data: { status: "ok", data: makeData(hours) },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

// Imported after the mocks above so the module picks them up.
const { default: GatewayClient } = await import("./gateway-client");

afterEach(() => {
  vi.clearAllMocks();
});

describe("GatewayClient window variable", () => {
  it("no longer declares a local `window` that shadows the global object", () => {
    const source = readFileSync(
      path.resolve(dirname, "gateway-client.tsx"),
      "utf8",
    );
    // The historical bug: `const window = WINDOW_OPTIONS[windowIdx] ...`
    expect(source).not.toMatch(/\bconst\s+window\s*=/);
    expect(source).not.toMatch(/\blet\s+window\s*=/);
    // The renamed variable should be present and used.
    expect(source).toMatch(/\bconst\s+activeWindow\s*=\s*WINDOW_OPTIONS/);
    expect(source).toMatch(/activeWindow\.label/);
    expect(source).toMatch(/activeWindow\.hours/);
  });

  it("switching windows updates the displayed label instead of a stale/broken `window` reference", () => {
    render(<GatewayClient />);

    // Default window is 24h.
    expect(screen.getByText("Spend (24h)")).toBeInTheDocument();

    // Switch to the 7d tab.
    fireEvent.click(screen.getByRole("tab", { name: "7d" }));

    expect(screen.getByText("Spend (7d)")).toBeInTheDocument();
    expect(screen.queryByText("Spend (24h)")).not.toBeInTheDocument();
  });

  it("export helpers receive the active window's label, proving `activeWindow` (not a shadowed `window`) drives filenames", async () => {
    render(<GatewayClient />);

    fireEvent.click(screen.getByRole("tab", { name: "30d" }));

    // Spend ChartCard mounts after chartsReady (post-paint dynamic island).
    const csvButtons = await screen.findAllByRole("button", { name: "CSV" });
    fireEvent.click(csvButtons[0]);

    expect(downloadCsv).toHaveBeenCalledWith(
      expect.stringContaining("30d"),
      expect.anything(),
    );
  });
});
