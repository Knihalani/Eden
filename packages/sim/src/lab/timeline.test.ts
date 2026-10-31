import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { Timeline } from "./timeline";
import { criticalPath, index, load, report, type SpanRec } from "./timeline-report";

const dir = mkdtempSync(join(tmpdir(), "eden-timeline-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const span = (id: number, parent: number, name: string, start: number, end: number, extra: Partial<SpanRec> = {}) =>
  ({ lane: "a", id, parent, name, startMs: start, endMs: end, cpuUs: (end - start) * 1_000, ...extra }) as SpanRec;

describe("timeline report", () => {
  test("the critical path follows the child that ended last, back to the start", () => {
    // slow 0..100: search 5..60 (two source calls, the slower ending at 55), probes 5..90 (outlives nothing:
    // ends before rank), rank 90..95, deliver 95..100.
    const spans = [
      span(1, 0, "slow", 0, 100, { attrs: { async: true } }),
      span(2, 1, "search", 5, 60, { attrs: { async: true } }),
      span(3, 2, "source.search", 6, 30, { attrs: { async: true } }),
      span(4, 2, "source.search", 6, 55, { attrs: { async: true } }),
      span(5, 1, "probes", 5, 90, { attrs: { async: true } }),
      span(6, 1, "rank", 90, 95),
      span(7, 1, "deliver", 95, 100),
      // A probe still running after the delivery is not on its path.
      span(8, 1, "probes.late", 50, 150, { attrs: { async: true } }),
    ];
    const ix = index(spans);
    const path = criticalPath(spans[0]!, 100, ix);
    const by = new Map<string, number>();
    for (const [name, ms] of path) by.set(name, (by.get(name) ?? 0) + ms);
    expect(by.get("deliver (self)")).toBe(5);
    expect(by.get("rank (self)")).toBe(5);
    expect(by.get("probes (self)")).toBe(85);
    expect(by.get("slow (self)")).toBe(5);
    expect(by.has("probes.late (self)")).toBe(false);
    expect([...by.values()].reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("a recorded run: spans per lane, tasks, samples, and a report over them", async () => {
    const path = join(dir, "run.jsonl");
    const timeline = new Timeline(path, { tool: "test" }, 20);
    const source = new StaticSource("crm", "Deals", [
      { ref: "d1", title: "Zorblax renewal", text: "Zorblax renewal due Friday, Dana Lee champions it" },
    ]);
    const partner = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      config: { probes: true },
      onSpan: timeline.sink("u1"),
      onTrace: timeline.traceSink("u1"),
    });
    const scope = { tenantId: "t", userId: "u", sessionId: "s1" };
    const task = timeline.task("u1", "s1", "task-1");
    await partner.observe(
      { ...scope, at: Date.now(), kind: "user_message", text: "Dana Lee: Zorblax renewal?" } as AgentEvent,
      {
        waitMs: 2_000,
      },
    );
    task.end({ delivered: true });
    await Bun.sleep(50);
    await timeline.close();
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { t: string });
    expect(lines[0]!.t).toBe("meta");
    expect(lines.at(-1)!.t).toBe("end");
    expect(lines.some((l) => l.t === "sample")).toBe(true);
    expect(lines.some((l) => l.t === "trace")).toBe(true);
    // Content-free: no request word or item text reaches the file.
    expect(readFileSync(path, "utf8")).not.toContain("Zorblax");
    const r = report(load(path), 5);
    expect(r.spans).toBeGreaterThan(5);
    expect(r.phases.rows.some((x) => x.name === "observe")).toBe(true);
    expect(r.critical.n).toBe(1);
    expect(r.slowest[0]!.id).toBe("task-1");
    expect(r.slowest[0]!.tree[0]).toContain("observe");
    expect(r.perSecond.length).toBeGreaterThan(0);
  });
});
