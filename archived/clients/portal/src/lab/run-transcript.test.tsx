/**
 * RunTranscript interaction tests: parallel lanes, j/k + h/l keyboard
 * cursor, ?step= deep links, F82 lazy payload fetch-once, step action bar.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptStep } from "@/lab/fixtures/traces";

vi.mock("@/lib/api/resources", () => ({
  agentIssuesApi: {
    reportStumble: vi.fn().mockResolvedValue({
      status: "ok",
      data: { stumble_id: "st_1" },
    }),
    createRegressionCases: vi.fn().mockResolvedValue({
      status: "ok",
      data: { cases: [], count: 1 },
    }),
  },
}));

const { agentIssuesApi } = await import("@/lib/api/resources");
const { RunTranscript } = await import("@/lab/lab-ui");

const T0 = Date.parse("2026-08-04T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function makeSteps(): TranscriptStep[] {
  return [
    {
      id: "s1",
      kind: "llm",
      title: "Plan the task",
      durationMs: 500,
      startedAt: at(0),
    },
    {
      id: "s2",
      kind: "tool",
      title: "search left",
      durationMs: 2_000,
      startedAt: at(500),
      parentId: "s1",
    },
    {
      id: "s3",
      kind: "tool",
      title: "search right",
      durationMs: 2_000,
      startedAt: at(900),
      parentId: "s1",
    },
    {
      id: "s4",
      kind: "span",
      title: "Summarise",
      durationMs: 300,
      startedAt: at(3_000),
    },
  ];
}

const transcript = () => screen.getByTestId("transcript-v2");
const activeStepId = (container: HTMLElement) =>
  container
    .querySelector('[data-active="true"]')
    ?.getAttribute("data-step-id") ??
  container
    .querySelector('[data-active="true"]')
    ?.closest("[data-step-id]")
    ?.getAttribute("data-step-id") ??
  null;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("RunTranscript parallel lanes", () => {
  it("renders overlapping same-parent tool steps as one lane group", () => {
    const { container } = render(<RunTranscript steps={makeSteps()} />);
    const group = container.querySelector("[data-parallel-group]");
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain("2 parallel");
    const lanes = group?.querySelectorAll("[data-lane-index]") ?? [];
    expect(lanes).toHaveLength(2);
    // Rows collapse: 4 steps → 3 view rows, reflected in aria-setsize.
    expect(
      container.querySelector("[data-step-id]")?.getAttribute("aria-setsize"),
    ).toBe("3");
  });
});

describe("RunTranscript keyboard cursor", () => {
  it("j/k walk rows, h/l walk lanes, Enter toggles the active step", () => {
    const { container } = render(<RunTranscript steps={makeSteps()} />);
    const root = transcript();

    fireEvent.keyDown(root, { key: "j" });
    expect(activeStepId(container)).toBe("s1");

    fireEvent.keyDown(root, { key: "j" });
    expect(activeStepId(container)).toBe("s2");

    fireEvent.keyDown(root, { key: "l" });
    expect(activeStepId(container)).toBe("s3");

    fireEvent.keyDown(root, { key: "h" });
    expect(activeStepId(container)).toBe("s2");

    fireEvent.keyDown(root, { key: "j" });
    expect(activeStepId(container)).toBe("s4");

    fireEvent.keyDown(root, { key: "k" });
    // Returning to the group from a plain row lands on the first lane.
    expect(activeStepId(container)).toBe("s2");

    // Enter on the container toggles the active step's detail open.
    expect(screen.queryByText("Copy step JSON")).toBeNull();
    fireEvent.keyDown(root, { key: "Enter" });
    expect(screen.getByText("Copy step JSON")).toBeInTheDocument();
    fireEvent.keyDown(root, { key: "Enter" });
    expect(screen.queryByText("Copy step JSON")).toBeNull();
  });

  it("mirrors the cursor to a ?step= URL param", () => {
    render(<RunTranscript steps={makeSteps()} />);
    fireEvent.keyDown(transcript(), { key: "j" });
    expect(new URLSearchParams(window.location.search).get("step")).toBe("s1");
    fireEvent.keyDown(transcript(), { key: "j" });
    expect(new URLSearchParams(window.location.search).get("step")).toBe("s2");
  });

  it("reports the cursor to the host instead when onActiveStepChange is set", () => {
    const onActive = vi.fn();
    render(
      <RunTranscript
        steps={makeSteps()}
        syncStepToUrl={false}
        onActiveStepChange={onActive}
      />,
    );
    fireEvent.keyDown(transcript(), { key: "j" });
    expect(onActive).toHaveBeenCalledWith("s1");
    expect(new URLSearchParams(window.location.search).get("step")).toBeNull();
  });

  it("reads ?step= on mount: opens and focuses that step", () => {
    window.history.replaceState(null, "", "/?step=s3");
    const { container } = render(<RunTranscript steps={makeSteps()} />);
    expect(activeStepId(container)).toBe("s3");
    // Deep-linked step is expanded (its detail carries the action bar).
    expect(screen.getByText("Copy step JSON")).toBeInTheDocument();
  });
});

describe("RunTranscript lazy payloads (F82)", () => {
  const lazySteps: TranscriptStep[] = [
    {
      id: "lz1",
      kind: "tool",
      title: "big tool call",
      durationMs: 10,
      outputPreview: JSON.stringify({
        _lazy: true,
        preview: "partial…",
        bytes: 4_096,
      }),
    },
  ];

  it("expand fetches the payload once, then renders it in full", async () => {
    const loader = vi.fn().mockResolvedValue("FULL PAYLOAD BODY");
    const { container } = render(
      <RunTranscript steps={lazySteps} loadStepPayload={loader} />,
    );

    const row = container.querySelector(
      '[data-step-id="lz1"] button',
    ) as HTMLElement;
    fireEvent.click(row);
    expect(await screen.findByText("FULL PAYLOAD BODY")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);

    // Collapse and re-expand: cached, no second fetch.
    fireEvent.click(row);
    fireEvent.click(row);
    expect(await screen.findByText("FULL PAYLOAD BODY")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("without a loader, shows the preview and says the payload is partial", () => {
    const { container } = render(<RunTranscript steps={lazySteps} />);
    fireEvent.click(
      container.querySelector('[data-step-id="lz1"] button') as HTMLElement,
    );
    expect(screen.getByText("partial…")).toBeInTheDocument();
    expect(screen.getByText(/full payload \(4\.0 KB\) not fetched/)).toBeInTheDocument();
  });
});

describe("RunTranscript step action bar", () => {
  function openFirstStep(container: HTMLElement) {
    fireEvent.click(
      container.querySelector('[data-step-id="s1"] button') as HTMLElement,
    );
  }

  it("Create issue reports a stumble against the org + trace", async () => {
    const { container } = render(
      <RunTranscript steps={makeSteps()} orgId="org_1" traceId="tr_9" />,
    );
    openFirstStep(container);
    fireEvent.click(screen.getByText("Create issue"));
    expect(await screen.findByText("Issue reported")).toBeInTheDocument();
    expect(agentIssuesApi.reportStumble).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({
        trace_id: "tr_9",
        span_id: "s1",
        title: expect.stringContaining("Plan the task"),
      }),
    );
  });

  it("disables API actions honestly when context is missing", () => {
    const { container } = render(<RunTranscript steps={makeSteps()} />);
    openFirstStep(container);
    const createIssue = screen.getByText("Create issue");
    const regression = screen.getByText("Add to regression");
    expect(createIssue).toBeDisabled();
    expect(createIssue).toHaveAttribute(
      "title",
      expect.stringContaining("Needs org + trace context"),
    );
    expect(regression).toBeDisabled();
    expect(regression).toHaveAttribute(
      "title",
      expect.stringContaining("build from an issue"),
    );
    expect(agentIssuesApi.reportStumble).not.toHaveBeenCalled();
  });

  it("Add to regression builds cases from the linked issue", async () => {
    const { container } = render(
      <RunTranscript
        steps={makeSteps()}
        orgId="org_1"
        traceId="tr_9"
        issueId="iss_5"
      />,
    );
    openFirstStep(container);
    fireEvent.click(screen.getByText("Add to regression"));
    expect(await screen.findByText("Added to regression")).toBeInTheDocument();
    expect(agentIssuesApi.createRegressionCases).toHaveBeenCalledWith(
      "org_1",
      "iss_5",
    );
  });

  it("Copy step JSON writes the step to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(<RunTranscript steps={makeSteps()} />);
    openFirstStep(container);
    fireEvent.click(screen.getByText("Copy step JSON"));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toMatchObject({
      id: "s1",
      title: "Plan the task",
    });
  });
});
