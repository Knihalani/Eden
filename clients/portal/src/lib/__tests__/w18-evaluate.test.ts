/**
 * Wave 18 — Evaluate depth structural + util contracts.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { charDiff } from "@/lib/char-diff";
import { readApiModules } from "./_read-api";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const api = () => readApiModules(ROOT);

describe("W18 playgrounds U03/F49", () => {
  it("ships persisted playgroundApi surface", () => {
    const a = api();
    expect(a).toContain("runPersisted");
    expect(a).toContain("fromSpan");
    expect(a).toContain("promoteExperiment");
    expect(a).toContain("/playgrounds");
  });

  it("playground page reads trace_id and binds dataset", () => {
    const page = src("app/(portal)/playgrounds/page.tsx");
    const hook = src("app/(portal)/playgrounds/_components/use-playgrounds-page.ts");
    expect(hook).toContain("trace_id");
    expect(hook).toContain("fromSpan");
    expect(hook).toContain("promoteExperiment");
    expect(hook).toContain("cost_usd");
    expect(page).toContain("Bind dataset");
  });
});

describe("W18 datasets U10/F53", () => {
  it("exposes updateRow, createSnapshot, importRows", () => {
    const a = api();
    expect(a).toContain("updateRow");
    expect(a).toContain("createSnapshot");
    expect(a).toContain("importRows");
    expect(a).toContain("promoteFromTrace");
  });

  it("dataset detail has inline edit + import + snapshots", () => {
    const page = src("app/(portal)/datasets/[id]/page.tsx");
    const hook = src("app/(portal)/datasets/[id]/_components/use-dataset-detail.ts");
    const sheet = src("app/(portal)/datasets/[id]/_components/dataset-spreadsheet.tsx");
    expect(hook).toContain("updateRow");
    expect(hook).toContain("createSnapshot");
    expect(hook).toContain("importRows");
    expect(page).toContain("Import");
    expect(sheet).toContain("VirtualizedList");
  });

  it("datasets list handles promote_trace query", () => {
    const hook = src("app/(portal)/datasets/_components/use-datasets-page.ts");
    expect(hook).toContain("promote_trace");
    expect(hook).toContain("promoteFromTrace");
  });
});

describe("W18 labeling U06/F50", () => {
  it("queues API has pushToDataset + iaa + get", () => {
    const a = api();
    expect(a).toContain("pushToDataset");
    expect(a).toContain("iaa:");
  });

  it("workstation has hotkeys 1-9 and transcript pane", () => {
    const page = src("app/(portal)/labeling/queues/[id]/page.tsx");
    const hotkeys = src("app/(portal)/labeling/queues/[id]/_components/queue-hotkeys.ts");
    const hook = src("app/(portal)/labeling/queues/[id]/_components/use-labeling-queue.ts");
    const transcript = src(
      "app/(portal)/labeling/queues/[id]/_components/queue-transcript.tsx",
    );
    expect(hotkeys).toContain("HOTKEY_LABELS");
    expect(transcript).toContain("Transcript");
    expect(hook).toContain("pushToDataset");
    expect(page).toContain("IAA");
    expect(hook).toContain("pairwise");
  });
});

describe("W18 experiments U07/F51", () => {
  it("multi-select compare + charDiff datapoints", () => {
    const page = src("app/(portal)/experiments/page.tsx");
    const panel = src("app/(portal)/experiments/_components/compare-panel.tsx");
    expect(page).toContain("Compare selected");
    expect(panel).toContain("charDiff");
    expect(page).toContain("datapoints");
    expect(panel).toContain("Side-by-side scores");
  });

  it("charDiff util detects prefix hunks", () => {
    const d = charDiff("hello world", "hello there");
    expect(d.equal).toBe(false);
    expect(d.commonPrefix).toBe("hello ");
  });
});

describe("W18 online scoring U14/F52", () => {
  it("create/edit/enable/test/rewind UI + SLM badge", () => {
    const page = src("app/(portal)/improve/online-scoring/page.tsx");
    const rules = src(
      "app/(portal)/improve/online-scoring/_components/online-scoring-rules.tsx",
    );
    expect(page).toContain("createScoringRule");
    expect(page).toContain("patchScoringRule");
    expect(page).toContain("rewindScoringRule");
    expect(page).toContain("applyScoring");
    expect(rules).toContain("SlmBadge");
    expect(rules).toContain("Switch");
  });
});

describe("W18 evals hub honesty", () => {
  it("evals hub documents studio/synthetic as live", () => {
    const page = src("app/(portal)/evals/page.tsx");
    expect(page).toContain("not stubs");
  });

  it("backend playground package + migration exist", () => {
    expect(existsSync(resolve(ROOT, "../../src/eden/playground/service.py"))).toBe(true);
    expect(
      existsSync(
        resolve(ROOT, "../../src/eden/db_migrations/versions/109_w18_playgrounds.py"),
      ),
    ).toBe(true);
  });
});
