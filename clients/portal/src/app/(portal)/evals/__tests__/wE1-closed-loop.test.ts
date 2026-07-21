/**
 * Wave E1 — IA truth + Observe→Eval closed loop contracts.
 * M7 batch promote · M8 fromSpan chip · M11 ≤5-click path · M12 embed · M14 empty grammar.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  playgroundHref,
  promoteTraceToDatasetHref,
  promoteTracesToDatasetHref,
  parsePromoteTraceIds,
  experimentHref,
} from "@/lib/portal-cross-links";
import { buildHubRedirectUrl } from "@/lib/portal-hub-redirect";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import {
  buildNavCommands,
  WAVE_E1_NAV_HYGIENE_COMPLETED,
} from "@/lib/nav-commands";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave E1 closed loop", () => {
  it("marks WAVE_E1 IA + closed-loop completed on hub", () => {
    const src = read("app/(portal)/evals/page.tsx");
    expect(src).toContain("WAVE_E1_IA_COMPLETED = true");
    expect(src).toContain("WAVE_E1_CLOSED_LOOP_COMPLETED = true");
    expect(src).toContain('data-wave-e1-evals="ia"');
    expect(src).toContain('data-wave-e1-closed-loop="path"');
    expect(src).toContain("Traces → dataset → playground → experiment");
    expect(src).toContain("not stubs");
    expect(src).toContain('PRIMARY_TABS = ["datasets", "playgrounds", "experiments"]');
    expect(src).not.toContain("PATH_LINKS");
    expect(src).not.toContain("CrossLinkBar");
  });

  it("M7: promote hrefs + parsePromoteTraceIds + batch N× promoteFromTrace", () => {
    const single = promoteTraceToDatasetHref("t1", { pastHours: "24" });
    expect(single).toContain("tab=datasets");
    expect(single).toContain("promote_trace=t1");
    expect(single).toContain("pastHours=24");

    const batch = promoteTracesToDatasetHref(["a", "b", "a"], { realm: "prod" });
    expect(batch).toContain("promote_traces=a%2Cb");
    expect(batch).toContain("realm=prod");
    expect(batch).not.toContain("promote_trace=");

    expect(promoteTracesToDatasetHref(["only"])).toContain("promote_trace=only");
    expect(promoteTracesToDatasetHref([])).toBe("/evals?tab=datasets");

    const sp = new URLSearchParams(
      "promote_trace=t1&promote_traces=t2,t3,t1",
    );
    expect(parsePromoteTraceIds(sp)).toEqual(["t1", "t2", "t3"]);

    const datasetsPage = read("app/(portal)/datasets/page.tsx");
    const datasetsHook = read(
      "app/(portal)/datasets/_components/use-datasets-page.ts",
    );
    const datasets = `${datasetsPage}\n${datasetsHook}`;
    expect(datasets).toContain("parsePromoteTraceIds");
    expect(datasets).toContain("promoteFromTrace");
    expect(datasets).toContain("promote_traces");
    expect(datasets).toContain("/evals?tab=datasets&datasetId=");

    const hubList = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(hubList).toContain("promoteTracesToDatasetHref");
    expect(hubList).toContain('label: "Add to dataset"');
    expect(hubList).toContain("selectable");
  });

  it("M8: Trace passes span_id; playground shows From production chip", () => {
    const panel = read("components/traces/TraceDetailPanel.tsx");
    expect(panel).toContain("playgroundHref(traceId, spanForPlayground, linkPreserve)");
    expect(panel).toContain('data-testid="trace-open-playground"');
    expect(panel).toContain('data-testid="trace-add-to-dataset"');
    expect(panel).toContain('data-wave-e1-trace-loop="primary"');

    const href = playgroundHref("trace-9", "span-42", { pastHours: "6" });
    expect(href).toContain("tab=playgrounds");
    expect(href).toContain("trace_id=trace-9");
    expect(href).toContain("span_id=span-42");
    expect(href).toContain("pastHours=6");

    const hook = read(
      "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
    );
    expect(hook).toContain("fromSpan");
    expect(hook).toContain("span_id: spanId");

    const pg = read("app/(portal)/playgrounds/page.tsx");
    expect(pg).toContain('data-wave-e1-from-production="chip"');
    expect(pg).toContain('data-testid="playground-from-production"');
    expect(pg).toContain("From production");
  });

  it("M11: ≤5-click path markers + issue→experiment primary CTA", () => {
    const hub = read("app/(portal)/evals/page.tsx");
    expect(hub).toContain("data-wave-e1-path-hint");
    expect(hub).toContain("Curate cases");
    expect(hub).toContain("Mutable iterate");
    expect(hub).toContain("Immutable compare");

    const issue = read(
      "app/(portal)/issues/_components/issue-experiment-panel.tsx",
    );
    expect(issue).toContain('data-wave-e1-issue-experiment="panel"');
    expect(issue).toContain('data-wave-e1-issue-experiment="primary-cta"');
    expect(issue).toContain("Run experiment");
    expect(issue).toContain("experimentHref");
    expect(experimentHref(undefined, "iss-1")).toContain("issueId=iss-1");
  });

  it("M12: embedded leaves honor useEmbeddedSurface / no CrossLinkBar", () => {
    const surfaces: Array<{ page: string; hook?: string }> = [
      {
        page: "app/(portal)/playgrounds/page.tsx",
        hook: "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
      },
      {
        page: "app/(portal)/experiments/page.tsx",
        hook: "app/(portal)/experiments/_components/use-experiments-page.ts",
      },
      {
        page: "app/(portal)/labeling/page.tsx",
        hook: "app/(portal)/labeling/_components/use-labeling-page.ts",
      },
      { page: "app/(portal)/studio/page.tsx" },
      { page: "app/(portal)/synthetic/page.tsx" },
      {
        page: "app/(portal)/datasets/page.tsx",
        hook: "app/(portal)/datasets/_components/use-datasets-page.ts",
      },
    ];
    for (const { page, hook } of surfaces) {
      const src = [read(page), hook ? read(hook) : ""].join("\n");
      expect(src).toContain("useEmbeddedSurface");
      expect(src).not.toContain("<CrossLinkBar");
    }
    expect(read("app/(portal)/studio/page.tsx")).toContain(
      'data-wave-e1-embed="studio"',
    );
    expect(read("app/(portal)/labeling/page.tsx")).toContain(
      'data-wave-e1-embed="labeling"',
    );
    expect(read("app/(portal)/synthetic/page.tsx")).toContain(
      'data-wave-e1-embed="synthetic"',
    );
    expect(read("app/(portal)/playgrounds/page.tsx")).toContain(
      'data-wave-e1-embed="playgrounds"',
    );
  });

  it("M14: empty-state grammar ≤3 CTAs (create / from traces / docs)", () => {
    const datasets = read("app/(portal)/datasets/page.tsx");
    expect(datasets).toContain('data-wave-e1-empty="datasets"');
    expect(datasets).toContain("From traces");
    expect(datasets).toContain("Create dataset");

    const experiments = read(
      "app/(portal)/experiments/_components/experiments-list.tsx",
    );
    expect(experiments).toContain('data-wave-e1-empty="experiments"');
    expect(experiments).toContain("From traces");
    expect(experiments).toContain("Create dataset");

    const playgrounds = read("app/(portal)/playgrounds/page.tsx");
    expect(playgrounds).toContain('data-wave-e1-empty="playgrounds"');
    expect(playgrounds).toContain("From traces");

    const labeling = read(
      "app/(portal)/labeling/_components/labeling-items-table.tsx",
    );
    expect(labeling).toContain('data-wave-e1-empty="labeling"');
  });

  it("E1.4/E1.5: redirect + nav/⌘K hygiene advertise /evals", () => {
    expect(WAVE_E1_NAV_HYGIENE_COMPLETED).toBe(true);

    const evaluate = DEFAULT_SIDEBAR.find((g) => g.id === "evaluate");
    expect((evaluate?.items ?? []).map((i) => i.href)).toEqual(["/evals"]);

    const cmds = buildNavCommands();
    const evalish = cmds.filter(
      (c) =>
        c.href === "/datasets" ||
        c.href === "/playgrounds" ||
        c.href === "/experiments" ||
        c.href === "/labeling" ||
        c.href === "/studio" ||
        c.href === "/synthetic",
    );
    expect(evalish).toEqual([]);

    const openEvals = cmds.find((c) => c.label === "Open Evals");
    expect(openEvals?.href).toBe("/evals");

    expect(
      buildHubRedirectUrl("/datasets", "?promote_trace=t9&pastHours=12"),
    ).toBe("/evals?promote_trace=t9&pastHours=12&tab=datasets");
    expect(
      buildHubRedirectUrl("/datasets", "?promote_traces=a,b"),
    ).toBe("/evals?promote_traces=a%2Cb&tab=datasets");
    expect(buildHubRedirectUrl("/observability/eval", "")).toBe(
      "/evals?tab=eval",
    );
  });
});
