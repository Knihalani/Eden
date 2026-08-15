// @vitest-environment jsdom
/**
 * Wave 14 — the keyboard-shortcut help dialog. Renders the shortcut map,
 * closes on Escape / scrim / X, and moves focus to the panel on open and
 * back to the trigger on close.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutHelp } from "@/lab/shortcut-help";

const ROWS = [
  { keys: "j / k", label: "Move through runs" },
  { keys: "/", label: "Focus search" },
];

describe("ShortcutHelp", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ShortcutHelp open={false} onClose={() => {}} shortcuts={ROWS} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the shortcut rows when open", () => {
    render(<ShortcutHelp open onClose={() => {}} shortcuts={ROWS} />);
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Move through runs")).toBeInTheDocument();
    expect(screen.getByText("Focus search")).toBeInTheDocument();
    expect(screen.getByText("j / k")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ShortcutHelp open onClose={onClose} shortcuts={ROWS} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on scrim click", () => {
    const onClose = vi.fn();
    render(<ShortcutHelp open onClose={onClose} shortcuts={ROWS} />);
    fireEvent.click(screen.getByLabelText("Close keyboard shortcuts"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the panel on open", () => {
    render(<ShortcutHelp open onClose={() => {}} shortcuts={ROWS} />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
