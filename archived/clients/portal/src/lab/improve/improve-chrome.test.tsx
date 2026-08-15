// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutonomyTierChip } from "@/lab/improve/improve-chrome";

describe("AutonomyTierChip", () => {
  it("renders Autonomy T2 for code-patch tier", () => {
    render(<AutonomyTierChip tierApplied="auto_code_patch_pr" />);
    expect(screen.getByText("Autonomy T2")).toBeTruthy();
  });

  it("renders nothing for unknown tiers", () => {
    const { container } = render(<AutonomyTierChip tierApplied="mystery" />);
    expect(container.textContent).toBe("");
  });
});
