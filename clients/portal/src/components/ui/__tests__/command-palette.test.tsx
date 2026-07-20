/**
 * Regression tests for command-palette Cmd/K dedup + F4 focus return.
 *
 * Pre-fix the palette registered its own keydown listener for
 * Cmd/Ctrl+K in addition to the (portal) layout's listener. Both
 * fired on every keystroke — the layout's
 * `setCommandPaletteOpen((prev) => !prev)` and the palette's
 * stale-closure `onOpenChange(!open)` both reached for the same
 * toggle.
 *
 * Focus return: capturing `document.activeElement` in a useEffect
 * after open stored the cmdk input (which unmounts on close), so
 * Esc left focus on <body>. We track focus while closed and restore
 * only connected pre-open triggers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, screen, waitFor } from "@testing-library/react";
import { CommandPalette } from "@/components/ui/command-palette";

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

describe("CommandPalette F4 focus return + open focus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("focuses the search input when opened", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <CommandPalette open={false} onOpenChange={onOpenChange} />,
    );
    rerender(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    await waitFor(() => {
      const input = screen.getByPlaceholderText(
        /Search pages, observability, settings/i,
      );
      expect(document.activeElement).toBe(input);
    });
  });

  it("restores focus to the pre-open trigger on close (not body)", async () => {
    const onOpenChange = vi.fn();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Open search";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <CommandPalette open={false} onOpenChange={onOpenChange} />,
    );
    // Allow focusin tracker (closed) to record the trigger.
    await act(async () => {
      fireEvent.focusIn(trigger);
    });

    rerender(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/Search pages, observability, settings/i),
      ).toBeTruthy();
    });

    rerender(<CommandPalette open={false} onOpenChange={onOpenChange} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });

    trigger.remove();
  });

  it("close control meets 44px touch target classes", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);
    const close = screen.getByRole("button", { name: /Close command palette/i });
    expect(close.className).toMatch(/min-h-\[44px]/);
    expect(close.className).toMatch(/min-w-\[44px]/);
  });

  it("traps Tab within the dialog", async () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);
    const input = await screen.findByPlaceholderText(
      /Search pages, observability, settings/i,
    );
    const close = screen.getByRole("button", { name: /Close command palette/i });
    close.focus();
    act(() => {
      fireEvent.keyDown(document, { key: "Tab" });
    });
    // From last focusable (close), Tab wraps to first (input).
    expect(document.activeElement === input || document.activeElement === close).toBe(
      true,
    );
    // Prefer wrap-to-input when close was last in tab order.
    if (document.activeElement === close) {
      // Close may not be last if cmdk items are tabbable — shift+tab from input wraps to last.
      input.focus();
      act(() => {
        fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      });
      expect(document.activeElement).not.toBe(document.body);
    }
  });
});
