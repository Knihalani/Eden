/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRetentionChartData,
  type CohortRetentionRow,
} from "../retention-curve-chart";

describe("buildRetentionChartData", () => {
  it("pivots cohort retention fractions into week-indexed % series", () => {
    const cohorts: CohortRetentionRow[] = [
      {
        cohort: "week-2026-07-20",
        start_date: "2026-07-20",
        size: 40,
        retention: { "0": 1, "1": 0.5, "2": 0.25 },
      },
      {
        cohort: "week-2026-07-27",
        start_date: "2026-07-27",
        size: 20,
        retention: { "0": 1, "1": 0.75 },
      },
    ];

    expect(buildRetentionChartData(cohorts)).toEqual([
      { week: "W0", "week-2026-07-20": 100, "week-2026-07-27": 100 },
      { week: "W1", "week-2026-07-20": 50, "week-2026-07-27": 75 },
      { week: "W2", "week-2026-07-20": 25, "week-2026-07-27": 0 },
    ]);
  });

  it("returns an empty series when there are no cohorts", () => {
    expect(buildRetentionChartData([])).toEqual([]);
  });
});

const cohortsFn = vi.fn();
vi.mock("@/lib/api/resources", () => ({
  analyticsApi: {
    cohorts: (...args: unknown[]) => cohortsFn(...args),
  },
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("@/lib/export", () => ({
  downloadCsv: vi.fn(),
  downloadPng: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockRetentionChart({
      cohorts,
    }: {
      cohorts: CohortRetentionRow[];
    }) {
      return (
        <div data-testid="retention-curve-chart">
          {cohorts.map((c) => c.cohort).join(",")}
        </div>
      );
    },
}));

type QueryState = {
  data: { cohorts: CohortRetentionRow[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

let queryState: QueryState;
const refetch = vi.fn();
vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: () => queryState,
}));

const { SessionRetentionPanel } = await import("../session-retention-panel");
const { downloadCsv } = await import("@/lib/export");

afterEach(() => {
  vi.clearAllMocks();
});

describe("SessionRetentionPanel", () => {
  it("shows empty state when the API returns no cohorts", () => {
    queryState = {
      data: { cohorts: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    };

    render(<SessionRetentionPanel />);

    expect(screen.getByText("No cohort retention yet")).toBeInTheDocument();
  });

  it("renders ChartCard chrome and exports CSV from live cohort rows", () => {
    queryState = {
      data: {
        cohorts: [
          {
            cohort: "week-2026-07-20",
            start_date: "2026-07-20",
            size: 12,
            retention: { "0": 1, "1": 0.5 },
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    };

    render(<SessionRetentionPanel weeks={8} />);

    expect(screen.getByText("Cohort retention")).toBeInTheDocument();
    expect(screen.getByTestId("retention-curve-chart")).toHaveTextContent(
      "week-2026-07-20",
    );

    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith(
      "eden-cohort-retention-8w.csv",
      [
        {
          cohort: "week-2026-07-20",
          start_date: "2026-07-20",
          size: 12,
          w0_pct: 100,
          w1_pct: 50,
        },
      ],
    );
  });
});
