import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// next/link renders as an <a> in tests.
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LegalPage } from "@/components/layout/legal-page";

describe("LegalPage", () => {
  it("renders the eyebrow, title, and description in a consistent shell", () => {
    const { getByText, getByRole, container } = render(
      <LegalPage eyebrow="Legal" title="Privacy" description="Lead paragraph copy.">
        <p>Body content</p>
      </LegalPage>
    );
    expect(getByText("Legal")).toBeTruthy();
    expect(getByRole("heading", { level: 1, name: "Privacy" })).toBeTruthy();
    expect(getByText("Lead paragraph copy.")).toBeTruthy();
    expect(getByText("Body content")).toBeTruthy();
    const back = Array.from(container.querySelectorAll('a[href="/"]')).find(
      (el) => el.textContent?.includes("Back to home")
    );
    expect(back).toBeTruthy();
  });

  it("supports a ReactNode description (bold + links)", () => {
    const { getByText } = render(
      <LegalPage
        eyebrow="Legal"
        title="DPA"
        description={
          <>
            Eden is the <strong>processor</strong> acting on documented instructions.
          </>
        }
      >
        <></>
      </LegalPage>
    );
    const strong = getByText("processor");
    expect(strong.tagName).toBe("STRONG");
  });

  it("accepts the size axis (narrow/medium/wide)", () => {
    const { container: c1 } = render(
      <LegalPage eyebrow="A" title="B" description="C" size="wide">
        <></>
      </LegalPage>
    );
    expect(c1.querySelector("main")?.className).toContain("max-w-5xl");
  });
});
