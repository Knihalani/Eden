/**
 * Wave 18 — Evaluate depth structural + util contracts.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { charDiff } from "@/lib/char-diff";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const api = () => readFileSync(resolve(ROOT, "src/lib/api.ts"), "utf8");

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
    expect(page).toContain("trace_id");
    expect(page).toContain("fromSpan");
    expect(page).toContain("promoteExperiment");
    expect(page).toContain("cost_usd");
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
    expect(page).toContain("updateRow");
    expect(page).toContain("createSnapshot");
    expect(page).toContain("importRows");
    expect(page).toContain("Import");
    expect(page).toContain("VirtualizedList");
  });

  it("datasets list handles promote_trace query", () => {
    const page = src("app/(portal)/datasets/page.tsx");
    expect(page).toContain("promote_trace");
    expect(page).toContain("promoteFromTrace");
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
    expect(page).toContain("HOTKEY_LABELS");
    expect(page).toContain("Transcript");
    expect(page).toContain("pushToDataset");
    expect(page).toContain("IAA");
    expect(page).toContain("pairwise");
  });
});

describe("W18 experiments U07/F51", () => {
  it("multi-select compare + charDiff datapoints", () => {
    const page = src("app/(portal)/experiments/page.tsx");
    expect(page).toContain("Compare selected");
    expect(page).toContain("charDiff");
    expect(page).toContain("datapoints");
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
    expect(page).toContain("createScoringRule");
    expect(page).toContain("patchScoringRule");
    expect(page).toContain("rewindScoringRule");
    expect(page).toContain("applyScoring");
    expect(page).toContain("SlmBadge");
    expect(page).toContain("Switch");
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
