/**
 * Regression test for the July 2026 command-palette Cmd/K dedup fix.
 *
 * Pre-fix the palette registered its own keydown listener for
 * Cmd/Ctrl+K in addition to the (portal) layout's listener. Both
 * fired on every keystroke — the layout's
 * `setCommandPaletteOpen((prev) => !prev)` and the palette's
 * stale-closure `onOpenChange(!open)` both reached for the same
 * toggle. The race manifested as: pressing Cmd+K once with the
 * palette closed would actually fire two opens and one close in
 * the same frame, ending with the palette left in whatever state
 * the second handler decided.
 *
 * Post-fix the palette owns only Escape (so the popover closes
 * when Esc is pressed while focus is in the input). The layout
 * is the single source of truth for Cmd/Ctrl+K, just like it
 * already is for Cmd/Ctrl+B and the backslash sidebar toggle.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CommandPalette } from "@/components/ui/command-palette";

// next/navigation is unused by CommandPalette but is imported via
// the layout that consumes it. Mock to keep the test self-contained.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

describe("CommandPalette Cmd/Ctrl+K dedup", () => {
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onOpenChange = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPalette(open: boolean) {
    return render(
      <CommandPalette open={open} onOpenChange={onOpenChange as unknown as (open: boolean) => void} />,
    );
  }

  it("does NOT call onOpenChange when Cmd+K is pressed while open", () => {
    renderPalette(true);
    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    // The palette must not toggle itself on Cmd+K — that's the
    // layout's job. Without this fix onOpenChange was called
    // twice per press (once by the palette's stale-closure
    // handler, once by the layout's updater-form handler).
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does NOT call onOpenChange when Ctrl+K is pressed while closed", () => {
    renderPalette(false);
    act(() => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("calls onOpenChange(false) when Escape is pressed while open", () => {
    renderPalette(true);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT call onOpenChange when Escape is pressed while closed", () => {
    renderPalette(false);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
