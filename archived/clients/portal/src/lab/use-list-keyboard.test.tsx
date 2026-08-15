// @vitest-environment jsdom
/**
 * Wave 14 — `useListKeyboard` grows two discoverability callbacks: `?`
 * opens a shortcut-help overlay and `/` focuses the list search field.
 * Both must fire only when the focus is not in a text input.
 */
import { fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useListKeyboard } from "@/lab/hooks";

function Harness({
  move,
  onTab,
  onHelp,
  onSearch,
}: {
  move: (d: number) => void;
  onTab?: (t: "trace" | "tree" | "signals" | "chat") => void;
  onHelp?: () => void;
  onSearch?: () => void;
}) {
  useListKeyboard({ move, onTab, onHelp, onSearch });
  return (
    <div>
      <input aria-label="search" />
    </div>
  );
}

describe("useListKeyboard", () => {
  it("still fires j/k navigation", () => {
    const move = vi.fn();
    render(<Harness move={move} />);
    fireEvent.keyDown(window, { key: "j" });
    expect(move).toHaveBeenCalledWith(1);
    fireEvent.keyDown(window, { key: "k" });
    expect(move).toHaveBeenCalledWith(-1);
  });

  it("fires onHelp for `?`", () => {
    const onHelp = vi.fn();
    render(<Harness move={vi.fn()} onHelp={onHelp} />);
    fireEvent.keyDown(window, { key: "?" });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it("fires onSearch for `/`", () => {
    const onSearch = vi.fn();
    render(<Harness move={vi.fn()} onSearch={onSearch} />);
    fireEvent.keyDown(window, { key: "/" });
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("does not fire ? / / while typing in an input", () => {
    const onHelp = vi.fn();
    const onSearch = vi.fn();
    const { getByLabelText } = render(
      <Harness move={vi.fn()} onHelp={onHelp} onSearch={onSearch} />,
    );
    const input = getByLabelText("search");
    fireEvent.keyDown(input, { key: "?" });
    fireEvent.keyDown(input, { key: "/" });
    expect(onHelp).not.toHaveBeenCalled();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("fires tab shortcuts when onTab is provided", () => {
    const onTab = vi.fn();
    render(<Harness move={vi.fn()} onTab={onTab} />);
    fireEvent.keyDown(window, { key: "s" });
    expect(onTab).toHaveBeenCalledWith("signals");
  });
});

// Keep the `useEffect` import used by the harness pattern (the hook itself
// attaches the listener; the harness just mounts the hook).
void useEffect;
