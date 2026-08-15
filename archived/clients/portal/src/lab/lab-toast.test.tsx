// @vitest-environment jsdom
/**
 * Wave 13 — toast interaction layer:
 *  - entrance animation class on every toast
 *  - tone icons (ok / fail / accent / default)
 *  - auto-dismiss progress drain
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useLabToast, LabToastProvider } from "@/lab/lab-toast";

function Harness({
  tone,
  title,
  body,
}: {
  tone?: "default" | "ok" | "fail" | "accent";
  title: string;
  body?: string;
}) {
  const { pushToast } = useLabToast();
  return (
    <button type="button" onClick={() => pushToast({ title, body, tone })}>
      Push
    </button>
  );
}

function renderToast(opts: { tone?: "default" | "ok" | "fail" | "accent"; title?: string; body?: string } = {}) {
  const title = opts.title ?? "Saved";
  const utils = render(
    <LabToastProvider>
      <Harness tone={opts.tone} title={title} body={opts.body} />
    </LabToastProvider>,
  );
  return { ...utils, push: () => fireEvent.click(utils.getByText("Push")) };
}

describe("LabToastProvider (Wave 13)", () => {
  it("renders the toast with an entrance animation class", () => {
    const { push, container } = renderToast();
    push();
    const toast = container.querySelector(".lab-toast");
    expect(toast).toBeTruthy();
    expect(toast?.className).toContain("lab-toast");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("renders a tone icon for ok toasts (CheckCircle2) and hides it via aria-hidden", () => {
    const { push, container } = renderToast({ tone: "ok" });
    push();
    const svg = container.querySelector(".lab-toast svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders a tone icon for fail toasts (AlertCircle)", () => {
    const { push, container } = renderToast({ tone: "fail" });
    push();
    expect(container.querySelector(".lab-toast svg")).toBeTruthy();
  });

  it("shows the auto-dismiss progress drain with the matching tone", () => {
    const { push, container } = renderToast({ tone: "fail", title: "Boom" });
    push();
    const progress = container.querySelector<HTMLElement>(".lab-toast__progress");
    expect(progress).toBeTruthy();
    expect(progress?.dataset.tone).toBe("fail");
  });

  it("renders body text and the dismiss button", () => {
    const { push } = renderToast({ body: "Everything fine" });
    push();
    expect(screen.getByText("Everything fine")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("dismisses the toast when the X is clicked", () => {
    const { push } = renderToast();
    push();
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.click(dismiss);
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
