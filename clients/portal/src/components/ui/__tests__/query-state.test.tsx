import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryState, resolveEmptySlot } from "../query-state";

describe("resolveEmptySlot", () => {
  it("prefers filterEmptySlot when filters are active", () => {
    expect(
      resolveEmptySlot({
        filtersActive: true,
        emptySlot: "zero",
        filterEmptySlot: "filtered",
      }),
    ).toBe("filtered");
  });

  it("falls back to emptySlot when filters are inactive", () => {
    expect(
      resolveEmptySlot({
        filtersActive: false,
        emptySlot: "zero",
        filterEmptySlot: "filtered",
      }),
    ).toBe("zero");
  });
});

describe("QueryState", () => {
  it("emits data-query-state=loading", () => {
    const { container } = render(
      <QueryState loading error={null} data={undefined}>
        {() => <span>ready</span>}
      </QueryState>,
    );
    expect(container.querySelector('[data-query-state="loading"]')).toBeTruthy();
  });

  it("emits data-query-state=error", () => {
    const { container } = render(
      <QueryState loading={false} error={new Error("boom")} data={null}>
        {() => <span>ready</span>}
      </QueryState>,
    );
    expect(container.querySelector('[data-query-state="error"]')).toBeTruthy();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("prefers filterEmptySlot and sets empty taxonomy attrs", () => {
    const { container } = render(
      <QueryState
        loading={false}
        error={null}
        data={{ items: [] }}
        isEmpty={(d) => d.items.length === 0}
        filtersActive
        emptyKind="filter-empty"
        emptySlot={<span>no data</span>}
        filterEmptySlot={<span>no matches</span>}
      >
        {() => <span>ready</span>}
      </QueryState>,
    );
    const empty = container.querySelector('[data-query-state="empty"]');
    expect(empty).toBeTruthy();
    expect(empty).toHaveAttribute("data-empty-kind", "filter-empty");
    expect(screen.getByText("no matches")).toBeInTheDocument();
    expect(screen.queryByText("no data")).toBeNull();
  });

  it("emits data-query-state=ready on success", () => {
    const { container } = render(
      <QueryState loading={false} error={null} data={{ ok: true }}>
        {(d) => <span>{d.ok ? "ok" : "no"}</span>}
      </QueryState>,
    );
    expect(container.querySelector('[data-query-state="ready"]')).toBeTruthy();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("calls onRetry from error action", () => {
    const onRetry = vi.fn();
    render(
      <QueryState
        loading={false}
        error={new Error("fail")}
        data={null}
        onRetry={onRetry}
      >
        {() => null}
      </QueryState>,
    );
    screen.getByRole("button", { name: /try again/i }).click();
    expect(onRetry).toHaveBeenCalled();
  });
});
