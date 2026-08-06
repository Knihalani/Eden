import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImprovementPlanEvent } from "@/lib/api/resources";

type QueryState = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

let queryState: QueryState;
vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: () => queryState,
}));

const { PlanEventLog } = await import("../plan-event-log");

function setEvents(events: ImprovementPlanEvent[]) {
  queryState = {
    data: { data: { events } },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

describe("PlanEventLog", () => {
  it("renders the append-only event trail with labels, tone, and detail", () => {
    setEvents([
      {
        id: "evt_1",
        event_type: "created",
        created_at: "2026-08-01T00:00:00Z",
        payload: {},
      },
      {
        id: "evt_2",
        event_type: "rejected",
        actor: "user_9",
        detail: "wontfix: not worth it",
        created_at: "2026-08-02T00:00:00Z",
        payload: {},
      },
    ]);

    render(
      <PlanEventLog orgId="org_1" planId="plan_1" isDraft={false} />,
    );

    expect(screen.getByText("Plan created")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(
      screen.getByText("by user_9 — wontfix: not worth it"),
    ).toBeInTheDocument();
  });

  it("shows an honest empty state when no events are recorded", () => {
    setEvents([]);
    render(
      <PlanEventLog orgId="org_1" planId="plan_1" isDraft={false} />,
    );
    expect(
      screen.getByText(/No events recorded yet/),
    ).toBeInTheDocument();
  });

  it("shows a draft placeholder without querying the server", () => {
    setEvents([]);
    render(<PlanEventLog orgId="org_1" planId="plan_from_x" isDraft />);
    expect(
      screen.getByText(/Unavailable for local draft plans/),
    ).toBeInTheDocument();
  });
});
