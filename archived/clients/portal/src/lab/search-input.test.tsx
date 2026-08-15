import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchInput } from "./lab-ui";

describe("SearchInput (Wave 12)", () => {
  it("renders a searchbox with a descriptive label and no clear button while empty", () => {
    render(
      <SearchInput
        value=""
        onChange={() => undefined}
        ariaLabel="Search runs"
        placeholder="Search runs, ids, agents…"
      />,
    );

    const input = screen.getByRole("searchbox", { name: "Search runs" });
    expect(input).toBeTruthy();
    expect(input.getAttribute("placeholder")).toBe(
      "Search runs, ids, agents…",
    );
    // No text → no clear affordance; nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("shows a clear button once the field has text", () => {
    render(
      <SearchInput value="abc" onChange={() => undefined} ariaLabel="Search runs" />,
    );
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  });

  it("clears the query and returns focus to the field on clear", () => {
    const onChange = vi.fn();
    render(
      <SearchInput value="abc" onChange={onChange} ariaLabel="Search runs" />,
    );

    const input = screen.getByRole("searchbox", { name: "Search runs" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(onChange).toHaveBeenCalledWith("");
    // Focus stays in the field so the next query is one keystroke away.
    expect(document.activeElement).toBe(input);
  });
});
