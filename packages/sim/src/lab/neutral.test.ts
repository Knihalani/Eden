import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld } from "../world";
import { gradeMessages, worldOf, type Task } from "./ab-common";
import {
  addNeutralTask,
  mergeNeutral,
  neutralLine,
  neutralRow,
  supportsNeutral,
  variantsFor,
  type NeutralOut,
} from "./neutral";
import { mixLines, mixRow, REALUSE_MIX, weightedRow, type WeightedSample } from "./pi-ab-weighted";
import { SUITES } from "./suites";

const s = (wallS: number, usd = 0, edenUsd = 0, tools = 0): WeightedSample => ({ usd, edenUsd, tools, wallS });
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("variantsFor", () => {
  test("neutral runs only on suites that build it; the others keep hidden and control", () => {
    expect(supportsNeutral("heldout14")).toBe(true);
    expect(variantsFor("heldout14", ["hidden", "control", "neutral"])).toEqual(["hidden", "control", "neutral"]);
    expect(variantsFor("heldout13", ["hidden", "control", "neutral"])).toEqual(["hidden", "control"]);
    expect(variantsFor("heldout12", ["neutral"])).toEqual([]);
    // The train suites build it since CL5 (suites.ts withNeutral).
    expect(variantsFor("train1", ["neutral"])).toEqual(["neutral"]);
    expect(() => variantsFor("heldout14", ["hiden" as "hidden"])).toThrow(/unknown variant/);
  });

  test("an older suite asked for neutral throws instead of planting its control", () => {
    expect(() => SUITES.heldout13!(buildWorld({ seed: 41_000 }), 41, "neutral")).toThrow(/no neutral variant/);
  });
});

describe("heldout14's neutral variant", () => {
  test("same requests and details as hidden and control, nothing planted, ids of its own", () => {
    const counts: number[] = [];
    const [hidden, control, neutral] = (["hidden", "control", "neutral"] as const).map((v) => {
      const world = buildWorld({ seed: 41_000 });
      const before = world.items.length;
      const tasks = SUITES.heldout14!(world, 41, v);
      counts.push(world.items.length - before);
      return tasks;
    });
    expect(hidden!.length).toBe(32);
    expect(counts).toEqual([32, 32, 0]);
    expect(neutral!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(neutral!.map((t) => t.detail)).toEqual(hidden!.map((t) => t.detail));
    expect(neutral!.every((t) => t.id.startsWith("w41:heldout14-neutral:"))).toBe(true);
    const ids = [...hidden!, ...control!, ...neutral!].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the live harnesses' world: kind neutral, no planted item, the detail as the must fact", () => {
    const { tasks } = worldOf(41, "heldout14", "neutral", { maxTasks: 0, maxOffworld: 0 });
    expect(tasks.length).toBe(32);
    expect(tasks.every((t) => t.kind === "neutral" && t.planted === undefined && t.must.length === 1)).toBe(true);
    const hidden = worldOf(41, "heldout14", "hidden", { maxTasks: 0, maxOffworld: 0 }).tasks;
    expect(hidden.every((t) => t.kind === "hidden" && typeof t.planted === "string")).toBe(true);
  });
});

describe("the grader on a neutral task", () => {
  const task = (kind: Task["kind"]): Task => ({
    id: "x",
    suite: "heldout14",
    kind,
    type: "t",
    event: "user_message",
    text: "Book the table.",
    must: [{ id: "t", detail: "the restaurant is closed on Mondays" }],
    secrets: [],
  });
  test("asks whether the answer raises the listed fact or any other concern", () => {
    const sys = gradeMessages(task("neutral"), "Booked.")[0]!.content;
    expect(sys).toContain("any other");
    expect(sys).toContain("false concerns");
  });
  test("hidden and control prompts are unchanged by it", () => {
    expect(gradeMessages(task("control"), "x")[0]!.content).not.toContain("any other");
    expect(gradeMessages(task("hidden"), "x")[0]!.content).not.toContain("any other");
  });
  test("the hidden prompt credits the substance: operative specifics, not every detail (D2085)", () => {
    const sys = gradeMessages(task("hidden"), "x")[0]!.content;
    expect(sys).toContain("operative specifics");
    expect(sys).toContain("need not repeat the fact's every detail");
    // Only the hidden branch loosens: control and neutral keep their own wording.
    expect(gradeMessages(task("control"), "x")[0]!.content).not.toContain("operative specifics");
    expect(gradeMessages(task("neutral"), "x")[0]!.content).not.toContain("operative specifics");
  });
});

describe("the funnel's neutral summary", () => {
  const t = (packets: number, injected = packets, extra: Partial<Parameters<typeof addNeutralTask>[1]> = {}) => ({
    injected,
    packets,
    packetBytes: 100 * packets,
    calls: 2,
    ms: 10,
    ...extra,
  });
  test("counts tasks with any packet, items, bytes, ask items and reader flags", () => {
    const r = neutralRow();
    addNeutralTask(r, t(0));
    addNeutralTask(r, t(2, 3, { askItems: 4, readerFlags: 1 }));
    expect(r).toEqual({
      n: 2,
      anyDelivered: 1,
      items: 3,
      packets: 2,
      packetBytes: 200,
      askItems: 4,
      anyFlagged: 1,
      calls: 4,
      ms: 20,
    });
    expect(neutralLine("heldout14", r)).toContain("any packet 1/2");
  });

  test("mergeNeutral sums parts and lays rows out by suite then seed, whatever the part order", () => {
    const part = (seed: number, packets: number): { neutral: NeutralOut } => {
      const r = neutralRow();
      addNeutralTask(r, t(packets));
      return {
        neutral: {
          total: r,
          suites: { heldout14: r },
          perTask: [{ suite: "heldout14", seed, template: "a", ...t(packets) }],
        },
      };
    };
    const m = mergeNeutral([part(42, 1), part(41, 0)], ["heldout14"], ["41", "42"])!;
    expect(m.perTask.map((x) => x.seed)).toEqual([41, 42]);
    expect(m.total.n).toBe(2);
    expect(m.total.anyDelivered).toBe(1);
    expect(m.suites.heldout14!.n).toBe(2);
    expect(mergeNeutral([{}, {}], ["heldout14"], ["41"])).toBeUndefined();
    expect(() => mergeNeutral([part(41, 0), {}], ["heldout14"], ["41"])).toThrow(/ran --neutral/);
  });
});

describe("the RealUse-1 traffic mix", () => {
  test("1 hidden, 1 control, 8 neutral: means by share, rates weighted, p50 pooled", () => {
    const row = mixRow("eden", {
      hidden: { share: REALUSE_MIX.hidden, samples: [s(10, 0.01)], rate: 0.5 },
      control: { share: REALUSE_MIX.control, samples: [s(10, 0.01)], rate: 0.2 },
      neutral: { share: REALUSE_MIX.neutral, samples: [s(1, 0.001), s(1, 0.001)], rate: 0.1 },
    })!;
    expect(row.perK).toBeCloseTo(1_000 * (0.1 * 0.01 + 0.1 * 0.01 + 0.8 * 0.001), 9);
    expect(row.raised).toBeCloseTo(0.05, 9);
    expect(row.falseConcern).toBeCloseTo(0.1 * 0.2 + 0.8 * 0.1, 9);
    // 80% of the weight is on 1 s tasks: the pooled median is 1 s, the p90 10 s.
    expect(row.p50).toBe(1);
    expect(row.p90).toBe(10);
    expect(mixLines([row]).join("\n")).toContain("1 hidden, 1 control, 8 neutral");
  });

  test("an ungraded kind in the mix leaves the false-concern share unknown, not smaller", () => {
    const row = mixRow("x", {
      hidden: { share: 0.1, samples: [s(1)], rate: 0.5 },
      control: { share: 0.1, samples: [s(1)], rate: 0.2 },
      neutral: { share: 0.8, samples: [s(1)] },
    })!;
    expect(row.falseConcern).toBeNull();
    expect(row.raised).toBeCloseTo(0.05, 9);
  });

  test("a kind with a share but no samples gives no row; with shares 0.5/0.5/0 it is the two-kind weighted row", () => {
    expect(mixRow("x", { hidden: { share: 0.5, samples: [s(1)] }, neutral: { share: 0.5, samples: [] } })).toBeNull();
    const h = [s(1, 0.01, 0.001, 2), s(3, 0.02, 0.002, 1)];
    const c = [s(2, 0.005, 0, 0)];
    const two = weightedRow("x", h, c, 0.5)!;
    const mix = mixRow("x", {
      hidden: { share: 0.5, samples: h },
      control: { share: 0.5, samples: c },
      neutral: { share: 0, samples: [] },
    })!;
    expect(mix.perK).toBeCloseTo(two.perK, 9);
    expect(mix.tools).toBeCloseTo(two.tools, 9);
    expect(mix.p50).toBe(two.p50!);
    expect(mix.p90).toBe(two.p90!);
  });
});

describe("hidden-funnel --neutral", () => {
  test("adds a neutral block and leaves the hidden and control rows as they were", () => {
    const dir = mkdtempSync(join(tmpdir(), "neutral-funnel-"));
    dirs.push(dir);
    const run = (json: string, extra: string[]) => {
      const p = Bun.spawnSync(
        [
          "bun",
          join(import.meta.dir, "hidden-funnel.ts"),
          "--suite",
          "heldout14",
          "--seeds",
          "41",
          "--limit",
          "2",
          "--no-record",
          "--json",
          json,
          // The default with its sync capped at 100 items a user (D819), as funnel-flags.test.ts runs it: storing the
          // default's 3,000 was most of each run's start-up, and nothing here needs them. Cut copies answer locally,
          // so a task's finds do not depend on a live search's timing.
          "--config",
          JSON.stringify({ syncMaxItems: 100, syncLocalComplete: false }),
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(p.exitCode).toBe(0);
      return { out: p.stdout.toString(), json: JSON.parse(readFileSync(json, "utf8")) };
    };
    const base = run(join(dir, "a.json"), []);
    const withN = run(join(dir, "b.json"), ["--neutral"]);
    expect(base.json.neutral).toBeUndefined();
    expect(withN.json.neutral.perTask.length).toBe(2);
    expect(withN.json.neutral.total.n).toBe(2);
    expect(withN.out).toContain("NEUTRAL heldout14:");
    // Timing fields differ between any two runs; everything else must match.
    const timing = new Set(["ms", "askMs", "deliveryMs", "readerWaitMs", "readerModelMs"]);
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !timing.has(k))));
    expect(strip(withN.json.perTask)).toEqual(strip(base.json.perTask));
    expect(withN.json.perTask.every((t: { variant: string }) => t.variant !== "neutral")).toBe(true);
    // The run-wide counters too: the neutral phase's use goes to its own block, never into the run's.
    const noTime = (x: Record<string, unknown> | undefined) =>
      x && Object.fromEntries(Object.entries(x).filter(([k]) => k !== "warmMs"));
    for (const k of ["calls", "intent", "cards", "reader"]) expect(withN.json[k]).toEqual(base.json[k]);
    expect(noTime(withN.json.sync)).toEqual(noTime(base.json.sync));
    expect(withN.json.neutral.use.calls.received).toBeGreaterThan(0);
  }, 60_000);
});
