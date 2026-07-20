import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ViewsMenu } from "../ViewsMenu";
import type { SavedViewRecord } from "@/lib/api";
import type { ViewState } from "../useSavedViews";

function makeView(
  id: string,
  name: string,
  state: ViewState = {},
  is_shared = false,
): SavedViewRecord & { state: ViewState } {
  return {
    id,
    org_id: "org",
    owner_id: "user",
    name,
    query_type: "text",
    query: state.q ?? "(all)",
    params: { resource: "traces", ...state },
    is_shared,
    is_pinned: false,
    tags: ["resource:traces"],
    use_count: 0,
    created_at: "",
    updated_at: "",
    state,
  };
}

describe("ViewsMenu (UX-P0-10)", () => {
  it("shows amber dirty trigger and Save changes / Discard when dirty", async () => {
    const onSave = vi.fn(async () => undefined);
    const onSaveChanges = vi.fn(async () => undefined);
    const onDiscard = vi.fn();
    const onSelect = vi.fn();

    render(
      <ViewsMenu
        views={[makeView("v1", "Prod", { filter: { realm: "prod" } })]}
        activeViewId="v1"
        dirty
        onSelect={onSelect}
        onSave={onSave}
        onSaveChanges={onSaveChanges}
        onDiscard={onDiscard}
      />,
    );

    expect(screen.getByRole("button", { expanded: false })).toHaveAttribute(
      "data-dirty",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByTestId("views-save-changes")).toBeInTheDocument();
    expect(screen.getByTestId("views-save-as")).toBeInTheDocument();
    expect(screen.getByTestId("views-discard")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("views-discard"));
    expect(onDiscard).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    render(
      <ViewsMenu
        views={[]}
        onSelect={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onDiscard={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Save as calls onSave with name", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <ViewsMenu
        views={[]}
        dirty
        onSelect={vi.fn()}
        onSave={onSave}
        onDiscard={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.change(screen.getByLabelText("Save as new view name"), {
      target: { value: "My view" },
    });
    fireEvent.click(screen.getByTestId("views-save-as"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("My view");
    });
  });

  it("hides Save changes when no active view", () => {
    render(
      <ViewsMenu
        views={[]}
        dirty
        onSelect={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveChanges={vi.fn(async () => undefined)}
        onDiscard={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByTestId("views-save-changes")).not.toBeInTheDocument();
  });
});
