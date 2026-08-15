// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DebuggerListView } from "./debugger-list-view";

vi.mock("@/lab/lab-ui", () => ({
  AgentScopeFilter: () => <div />,
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
  SearchInput: () => <input aria-label="Search debugger sessions" />,
}));

describe("DebuggerListView (R035)", () => {
  it("disables New session when there are no traces", () => {
    render(
      <DebuggerListView
        sessions={[]}
        query=""
        onQueryChange={() => {}}
        agentId="all"
        onAgentChange={() => {}}
        onSelect={() => {}}
        onNew={vi.fn()}
        canCreate={false}
      />,
    );
    expect(screen.getByRole("button", { name: "New session" })).toBeDisabled();
  });
});
