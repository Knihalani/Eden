// @vitest-environment jsdom
/**
 * Wave 11 — plain-language severity/status vocabulary across the site.
 *
 * Before: badges and filter chips rendered raw enum fragments ("fail", "warn",
 * "ok"), and feed rows showed raw ISO timestamps. Users had to decode the
 * data model to read the UI.
 *
 * After:
 *  - SeverityBadge: "Failed" / "Warning" / "OK" (was "fail" / "warn" / "ok").
 *  - Feed rows show formatRelativeTime() instead of raw startedAt ISO strings.
 *  - Session turns map "error"→"failed", "mixed"→"warning".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeverityBadge, severityLabel } from "@/lab/lab-ui";

describe("SeverityBadge (Wave 11 plain-language vocabulary)", () => {
  it("renders 'Failed' for error severity", () => {
    render(<SeverityBadge severity="error" />);
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("renders 'Warning' for warn severity", () => {
    render(<SeverityBadge severity="warn" />);
    expect(screen.getByText("Warning")).toBeTruthy();
  });

  it("renders 'OK' for none severity", () => {
    render(<SeverityBadge severity="none" />);
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("never shows the raw enum fragments", () => {
    const { container } = render(
      <>
        <SeverityBadge severity="error" />
        <SeverityBadge severity="warn" />
        <SeverityBadge severity="none" />
      </>,
    );
    expect(container.textContent).not.toContain("fail");
    expect(container.textContent).not.toContain("warn");
    expect(container.textContent).not.toContain("ok");
  });
});

describe("severityLabel (shared site-wide vocabulary)", () => {
  it("maps every known severity to plain words", () => {
    expect(severityLabel("critical")).toBe("Critical");
    expect(severityLabel("error")).toBe("Failed");
    expect(severityLabel("warn")).toBe("Warning");
    expect(severityLabel("none")).toBe("OK");
    expect(severityLabel("ok")).toBe("OK");
  });

  it("passes unknown severities through unchanged", () => {
    expect(severityLabel("unknown_thing")).toBe("unknown_thing");
  });
});
