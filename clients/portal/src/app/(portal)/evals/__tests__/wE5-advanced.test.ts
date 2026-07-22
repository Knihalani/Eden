/**
 * Wave E5 — Advanced leaves contracts.
 * Scores · Labeling · Studio · Synthetic · embed · hub Advanced menu.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE_E5_SCORES_COMPLETED } from "../../observability/eval/_components/use-scores-page";
import { WAVE_E5_LABELING_COMPLETED } from "../../labeling/_components/use-labeling-page";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function loc(rel: string): number {
  return read(rel).split("\n").length;
}

describe("Wave E5 Advanced leaves", () => {
  it("marks WAVE_E5 completed flags", () => {
    expect(WAVE_E5_SCORES_COMPLETED).toBe(true);
    expect(WAVE_E5_LABELING_COMPLETED).toBe(true);

    const hub = read("app/(portal)/evals/page.tsx");
    expect(hub).toContain("WAVE_E5_ADVANCED_COMPLETED = true");
    expect(hub).toContain("WAVE_E5_HUB_MENU_COMPLETED = true");

    expect(read("app/(portal)/studio/page.tsx")).toContain(
      "WAVE_E5_STUDIO_COMPLETED = true",
    );
    expect(read("app/(portal)/synthetic/page.tsx")).toContain(
      "WAVE_E5_SYNTHETIC_COMPLETED = true",
    );
  });

  it("E5.1: Scores thin panel — versions + clusters + Improve link", () => {
    const pageLoc = loc("app/(portal)/observability/eval/page.tsx");
    expect(pageLoc).toBeLessThanOrEqual(200);

    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/observability/eval/_components/versions-panel.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/observability/eval/_components/failure-clusters-panel.tsx",
        ),
      ),
    ).toBe(true);

    const page = read("app/(portal)/observability/eval/page.tsx");
    expect(page).toContain('data-wave-e5-scores="panel"');
    expect(page).toContain('data-wave-e5-scores="improve-link"');
    expect(page).toContain('href="/improve/online-scoring"');
    expect(page).toContain("useScoresPage");
    expect(page).toContain("VersionsPanel");
    expect(page).toContain("FailureClustersPanel");
    expect(page).not.toContain('from "@/components/ui/card"');

    const hook = read(
      "app/(portal)/observability/eval/_components/use-scores-page.ts",
    );
    expect(hook).toContain("useEmbeddedSurface");

    const versions = read(
      "app/(portal)/observability/eval/_components/versions-panel.tsx",
    );
    const clusters = read(
      "app/(portal)/observability/eval/_components/failure-clusters-panel.tsx",
    );
    expect(versions).toContain('data-wave-e5-scores="versions"');
    expect(versions).toContain("evalApi.listVersions");
    expect(versions).toContain("evalApi.tagVersion");
    expect(clusters).toContain('data-wave-e5-scores="clusters"');
    expect(clusters).toContain("evalApi.failureClusters");
  });

  it("E5.2: Labeling list split — empty 3-sources + push-to-dataset", () => {
    const pageLoc = loc("app/(portal)/labeling/page.tsx");
    expect(pageLoc).toBeLessThanOrEqual(250);

    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/labeling/_components/labeling-queues-section.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/labeling/_components/labeling-items-table.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/labeling/_components/use-labeling-page.ts"),
      ),
    ).toBe(true);

    const page = read("app/(portal)/labeling/page.tsx");
    expect(page).toContain('data-wave-e5-labeling="list"');
    expect(page).toContain("useLabelingPage");
    expect(page).toContain("LabelingQueuesSection");
    expect(page).toContain("LabelingItemsTable");
    expect(page).toContain("embedded={page.embedded}");

    const items = read("app/(portal)/labeling/_components/labeling-items-table.tsx");
    expect(items).toContain('data-testid="labeling-empty-sources"');
    expect(items).toContain('data-wave-e1-empty="labeling"');
    expect(items).toContain("From traces");
    expect(items).toContain("Seed item");
    expect(items).toContain("Create queue");

    const queues = read(
      "app/(portal)/labeling/_components/labeling-queues-section.tsx",
    );
    expect(queues).toContain('data-wave-e5-labeling="push-to-dataset"');
    expect(queues).toContain("Push to dataset");

    const hook = read("app/(portal)/labeling/_components/use-labeling-page.ts");
    expect(hook).toContain("labelingQueuesApi.pushToDataset");
    expect(hook).toContain("datasetsApi.create");
    expect(hook).toContain("useEmbeddedSurface");
  });

  it("E5.3: Labeling queue modular + documented hotkeys", () => {
    const pageLoc = loc("app/(portal)/labeling/queues/[id]/page.tsx");
    expect(pageLoc).toBeLessThanOrEqual(200);

    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/labeling/queues/[id]/_components/use-labeling-queue.ts",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/labeling/queues/[id]/_components/queue-hotkeys-strip.tsx",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/labeling/queues/[id]/_components/queue-export.tsx",
        ),
      ),
    ).toBe(true);

    const page = read("app/(portal)/labeling/queues/[id]/page.tsx");
    expect(page).toContain('data-wave-e5-labeling="queue"');
    expect(page).toContain("QueueHotkeysStrip");
    expect(page).toContain("QueueExport");
    expect(page).toContain("embedded={q.embedded}");

    const queueHook = read(
      "app/(portal)/labeling/queues/[id]/_components/use-labeling-queue.ts",
    );
    expect(queueHook).toContain("useEmbeddedSurface");

    const hotkeys = read(
      "app/(portal)/labeling/queues/[id]/_components/queue-hotkeys-strip.tsx",
    );
    expect(hotkeys).toContain('data-wave-e5-labeling="hotkeys"');
    expect(hotkeys).toMatch(/skip/i);

    const hotkeyLogic = read(
      "app/(portal)/labeling/queues/[id]/_components/queue-hotkeys.ts",
    );
    expect(hotkeyLogic).toContain("HOTKEY_LABELS");
    expect(hotkeyLogic).toContain("metaKey");
    expect(hotkeyLogic).toContain('"?"');

    const exp = read(
      "app/(portal)/labeling/queues/[id]/_components/queue-export.tsx",
    );
    expect(exp).toContain('data-wave-e5-labeling="queue-push"');
    expect(exp).toContain("Push to dataset");
  });

  it("E5.4: Studio 3-tab declutter + markers", () => {
    const page = read("app/(portal)/studio/page.tsx");
    expect(page).toContain('data-wave-e5-studio="shell"');
    expect(page).toContain("useEmbeddedSurface");
    expect(page).toContain('variant="underline"');
    expect(page).toContain("TemplatesTab");
    expect(page).toContain("FromExamplesTab");
    expect(page).toContain("MyMetricsTab");
    expect(page).not.toContain('variant="pills"');

    const templates = read("app/(portal)/studio/_components/templates-tab.tsx");
    const examples = read("app/(portal)/studio/_components/from-examples-tab.tsx");
    const metrics = read("app/(portal)/studio/_components/my-metrics-tab.tsx");
    expect(templates).toContain('data-wave-e5-studio="templates"');
    expect(examples).toContain('data-wave-e5-studio="examples"');
    expect(metrics).toContain('data-wave-e5-studio="metrics"');
    expect(templates).not.toContain("rounded-full");
  });

  it("E5.5: Synthetic generation UX + honest deferred history", () => {
    const pageLoc = loc("app/(portal)/synthetic/page.tsx");
    expect(pageLoc).toBeLessThanOrEqual(220);

    const page = read("app/(portal)/synthetic/page.tsx");
    expect(page).toContain('data-wave-e5-synthetic="shell"');
    expect(page).toContain('data-wave-e5-synthetic="generate"');
    expect(page).toContain('data-wave-e5-synthetic="results"');
    expect(page).toContain('data-wave-e5-synthetic="history-deferred"');
    expect(page).toContain("useEmbeddedSurface");
    expect(page).toContain("qaApi.generate");
    expect(page).toContain("qaApi.listRuns");
    expect(page).toMatch(/Persisted run history is deferred/i);
    expect(page).not.toContain('data-testid="synthetic-runs-table"');
  });

  it("E5.6: Advanced leaves honor useEmbeddedSurface / no double header chrome", () => {
    const leaves: Array<{ page: string; hook?: string }> = [
      {
        page: "app/(portal)/observability/eval/page.tsx",
        hook: "app/(portal)/observability/eval/_components/use-scores-page.ts",
      },
      {
        page: "app/(portal)/labeling/page.tsx",
        hook: "app/(portal)/labeling/_components/use-labeling-page.ts",
      },
      {
        page: "app/(portal)/labeling/queues/[id]/page.tsx",
        hook: "app/(portal)/labeling/queues/[id]/_components/use-labeling-queue.ts",
      },
      { page: "app/(portal)/studio/page.tsx" },
      { page: "app/(portal)/synthetic/page.tsx" },
    ];
    for (const { page, hook } of leaves) {
      const src = read(page);
      expect(src).toContain("embedded=");
      expect(src).not.toContain("CrossLinkBar");
      if (hook) {
        expect(read(hook)).toContain("useEmbeddedSurface");
      } else {
        expect(src).toContain("useEmbeddedSurface");
      }
    }

    const hub = read("app/(portal)/evals/page.tsx");
    expect(hub).toContain("");
    expect(hub).toContain("EvalView");
    expect(hub).toContain("LabelingView");
    expect(hub).toContain("StudioView");
    expect(hub).toContain("SyntheticView");
  });

  it("E5.7: Hub Advanced menu — labels + one-line jobs; no Go-to dupes", () => {
    const hub = read("app/(portal)/evals/page.tsx");
    expect(hub).toContain('data-wave-e5-evals="advanced"');
    expect(hub).toContain('data-wave-e5-advanced="menu"');
    expect(hub).toContain('data-testid="evals-advanced-menu"');
    expect(hub).toContain("Versions + failure clusters");
    expect(hub).toContain("Human labels → datasets");
    expect(hub).toContain("Custom metric rubrics");
    expect(hub).toContain("Generate Q/A triples");
    expect(hub).not.toMatch(/Go to|PATH_LINKS|Go-to/i);
    expect(hub).toContain("job:");
  });

  it("E5 shells stay thin (LOC budgets)", () => {
    expect(loc("app/(portal)/observability/eval/page.tsx")).toBeLessThanOrEqual(200);
    expect(loc("app/(portal)/labeling/page.tsx")).toBeLessThanOrEqual(250);
    expect(loc("app/(portal)/labeling/queues/[id]/page.tsx")).toBeLessThanOrEqual(200);
    expect(loc("app/(portal)/studio/page.tsx")).toBeLessThanOrEqual(200);
    expect(loc("app/(portal)/synthetic/page.tsx")).toBeLessThanOrEqual(220);
  });
});
