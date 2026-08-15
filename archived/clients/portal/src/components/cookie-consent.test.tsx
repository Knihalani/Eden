// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
}));

import { CookieConsent } from "./cookie-consent";

describe("CookieConsent (R031)", () => {
  it("sits above the tour scrim so Decline is clickable", () => {
    render(<CookieConsent />);
    const dialog = screen.getByRole("dialog", { name: "Cookie preferences" });
    expect(dialog.className).toContain("z-[130]");
    expect(dialog.className).toContain("max-w-sm");
    expect(dialog.className).not.toContain("inset-x-0");
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  });
});
