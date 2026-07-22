/**
 * CommandPalette — self-contained open state (Phase 1+ kill-list).
 * ⌘K / Ctrl+K toggles; openCommandPalette() / COMMAND_PALETTE_OPEN_EVENT opens.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, fireEvent, act, screen, waitFor } from "@testing-library/react";
import {
  CommandPalette,
  COMMAND_PALETTE_OPEN_EVENT,
  openCommandPalette,
} from "@/components/ui/command-palette";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

describe("CommandPalette", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens via openCommandPalette / COMMAND_PALETTE_OPEN_EVENT", async () => {
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      openCommandPalette();
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
  });

  it("toggles on Cmd+K", async () => {
    render(<CommandPalette />);

    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("exposes COMMAND_PALETTE_OPEN_EVENT constant", () => {
    expect(COMMAND_PALETTE_OPEN_EVENT).toBe("eden:open-command-palette");
  });
});
