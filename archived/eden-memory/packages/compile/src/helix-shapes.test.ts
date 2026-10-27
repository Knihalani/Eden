/**
 * Compact Helix shape pins: offset, unique, sort, reduce, deep flatten, retry,
 * barcode binds. No campaign Session.
 */
import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { compileTraces } from "./index";
import { registryFrom, runProgram } from "@eden/runtime";

function trace(id: string, events: StretchTrace["events"], input: Record<string, unknown>): StretchTrace {
  return {
    id,
    events,
    input,
    output: { ok: true },
    llmCalls: events.filter((e) => e.ok).length,
    duration_ms: 40,
    cost_cents: 4,
    complete: true,
  };
}

describe("helix shapes", () => {
  test("offset page/limit walk then foreach, not a cursor nextCursor", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const project = `gl-${i}`;
      const pages = [1, 2, 3].map((page) => ({
        items: [{ iid: (page - 1) * 2 + 1 }, { iid: (page - 1) * 2 + 2 }],
        page,
        limit: 2,
        totalPages: 3,
      }));
      return trace(
        `off-${i}`,
        [
          ...pages.map((p) => ({
            name: "listIssues",
            args: { project, page: p.page, limit: 2 },
            result: p,
            ok: true,
          })),
          ...pages.flatMap((p) =>
            p.items.map((it) => ({
              name: "commentIssue",
              args: { project, iid: it.iid },
              result: { commented: true, iid: it.iid },
              ok: true,
            })),
          ),
          { name: "closeBoard", args: { project }, result: { closed: true }, ok: true },
        ],
        { project },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop" && s.until));
    expect(p).toBeDefined();
    const pageLoop = p!.steps.find((s) => s.kind === "loop" && s.until);
    expect(pageLoop && pageLoop.kind === "loop" && /page|totalPages|items/.test(pageLoop.until ?? "")).toBe(true);
    const body = p!.steps.find((s) => s.kind === "tool" && s.tool === "listIssues");
    expect(body && body.kind === "tool").toBe(true);
    if (body && body.kind === "tool") {
      expect(body.args.page?.kind === "transform" && body.args.page.fn === "add").toBe(true);
      expect(JSON.stringify(body.args)).not.toMatch(/nextCursor/);
    }
    expect(p!.steps.some((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "flatten")).toBe(
      true,
    );

    const seen: number[] = [];
    const reg = registryFrom({
      listIssues: async ({ page }) => {
        const pg = Number(page);
        return {
          items: [{ iid: (pg - 1) * 2 + 1 }, { iid: (pg - 1) * 2 + 2 }],
          page: pg,
          limit: 2,
          totalPages: 3,
        };
      },
      commentIssue: async ({ iid }) => {
        seen.push(Number(iid));
        return { commented: true };
      },
      closeBoard: async () => ({ closed: true }),
    });
    await runProgram(p!, { project: "gl-0" }, { registry: reg, checkEnvelope: false });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("unique first-seen by addr; sort desc prio; reduce sum amt", async () => {
    const uniqueTraces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const inbox = `ib-${i}`;
      const rows = [
        { addr: `${inbox}-a@ex.test`, n: 1 },
        { addr: `${inbox}-b@ex.test`, n: 2 },
        { addr: `${inbox}-a@ex.test`, n: 3 },
        { addr: `${inbox}-c@ex.test`, n: 4 },
        { addr: `${inbox}-b@ex.test`, n: 5 },
      ];
      const addrs = [`${inbox}-a@ex.test`, `${inbox}-b@ex.test`, `${inbox}-c@ex.test`];
      return trace(
        `u-${i}`,
        [
          { name: "listInbox", args: { inbox }, result: { rows }, ok: true },
          ...addrs.map((addr) => ({
            name: "sendDigest",
            args: { addr },
            result: { sent: true, addr },
            ok: true,
          })),
          { name: "closeInbox", args: { inbox }, result: { closed: true }, ok: true },
        ],
        { inbox },
      );
    });
    const uniqed = compileTraces(uniqueTraces);
    const up = uniqed.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(up, uniqed.refusals.map((r) => r.reason).join("|")).toBeDefined();
    const uover = up!.steps.find((s) => s.kind === "loop")!;
    expect(uover.kind === "loop" && uover.over.kind === "transform" && uover.over.fn === "unique").toBe(true);
    if (uover.kind === "loop" && uover.over.kind === "transform") expect(uover.over.expr).toBe("addr");

    const sortTraces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const queue = `q-${i}`;
      const jobs = [
        { id: `${queue}-c`, prio: 1 },
        { id: `${queue}-a`, prio: 9 },
        { id: `${queue}-b`, prio: 5 },
      ];
      const ordered = [...jobs].sort((a, b) => b.prio - a.prio);
      return trace(
        `s-${i}`,
        [
          { name: "listJobs", args: { queue }, result: { jobs }, ok: true },
          ...ordered.map((j) => ({
            name: "drainJob",
            args: { id: j.id },
            result: { drained: true, id: j.id },
            ok: true,
          })),
          { name: "closeQueue", args: { queue }, result: { closed: true }, ok: true },
        ],
        { queue },
      );
    });
    const sorted = compileTraces(sortTraces);
    const sp = sorted.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(sp, sorted.refusals.map((r) => r.reason).join("|")).toBeDefined();
    const sover = sp!.steps.find((s) => s.kind === "loop")!;
    expect(sover.kind === "loop" && sover.over.kind === "transform" && sover.over.fn === "sort").toBe(true);
    if (sover.kind === "loop" && sover.over.kind === "transform") expect(sover.over.expr).toBe("-prio");

    const reduceTraces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const batch = `bat-${i}`;
      const lines = [
        { id: `${batch}-l0`, amt: 10 },
        { id: `${batch}-l1`, amt: 25 },
        { id: `${batch}-l2`, amt: 5 },
      ];
      return trace(
        `r-${i}`,
        [
          { name: "listLines", args: { batch }, result: { lines }, ok: true },
          ...lines.map((l) => ({
            name: "postLine",
            args: { id: l.id, amt: l.amt },
            result: { posted: true, id: l.id, amt: l.amt },
            ok: true,
          })),
          { name: "settleBatch", args: { batch, total: 40 }, result: { settled: true, batch, total: 40 }, ok: true },
        ],
        { batch },
      );
    });
    const reduced = compileTraces(reduceTraces);
    const rp = reduced.programs.find((q) => q.steps.some((s) => s.kind === "tool" && s.tool === "settleBatch"));
    expect(rp, reduced.refusals.map((r) => r.reason).join("|")).toBeDefined();
    const settle = rp!.steps.find((s) => s.kind === "tool" && s.tool === "settleBatch");
    expect(settle && settle.kind === "tool").toBe(true);
    if (settle && settle.kind === "tool") {
      expect(settle.args.total?.kind === "transform" && settle.args.total.fn === "reduce").toBe(true);
      if (settle.args.total?.kind === "transform") expect(settle.args.total.expr).toBe("sum:amt");
    }

    const totals: number[] = [];
    const reg = registryFrom({
      listLines: async () => ({
        lines: [
          { id: "bat-0-l0", amt: 10 },
          { id: "bat-0-l1", amt: 25 },
          { id: "bat-0-l2", amt: 5 },
        ],
      }),
      postLine: async () => ({ posted: true }),
      settleBatch: async ({ total }) => {
        totals.push(Number(total));
        return { settled: true };
      },
    });
    await runProgram(rp!, { batch: "bat-0" }, { registry: reg, checkEnvelope: false });
    expect(totals).toEqual([40]);
  });

  test("deep:children flatten of a nested tree, not one-level blocks", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const tree = `tree-${i}`;
      const root = {
        path: `${tree}/root`,
        children: [
          {
            path: `${tree}/a`,
            children: [{ path: `${tree}/a/f0.txt` }, { path: `${tree}/a/f1.txt` }],
          },
          { path: `${tree}/b`, children: [{ path: `${tree}/b/f0.txt` }] },
        ],
      };
      const leaves = [`${tree}/a/f0.txt`, `${tree}/a/f1.txt`, `${tree}/b/f0.txt`];
      return trace(
        `t-${i}`,
        [
          { name: "listTree", args: { tree }, result: { tree: root }, ok: true },
          ...leaves.map((path) => ({
            name: "scanFile",
            args: { path },
            result: { scanned: true, path },
            ok: true,
          })),
          { name: "sealTree", args: { tree }, result: { sealed: true, tree }, ok: true },
        ],
        { tree },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p, refusals.map((r) => r.reason).join("|")).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop")!;
    expect(loop.kind === "loop" && loop.over.kind === "transform" && loop.over.fn === "flatten").toBe(true);
    if (loop.kind === "loop" && loop.over.kind === "transform") {
      expect(loop.over.expr).toBe("deep:children");
    }

    const scanned: string[] = [];
    const root = {
      path: "tree-0/root",
      children: [
        { path: "tree-0/a", children: [{ path: "tree-0/a/f0.txt" }, { path: "tree-0/a/f1.txt" }] },
        { path: "tree-0/b", children: [{ path: "tree-0/b/f0.txt" }] },
      ],
    };
    const reg = registryFrom({
      listTree: async () => ({ tree: root }),
      scanFile: async ({ path }) => {
        scanned.push(String(path));
        return { scanned: true };
      },
      sealTree: async () => ({ sealed: true }),
    });
    await runProgram(p!, { tree: "tree-0" }, { registry: reg, checkEnvelope: false });
    expect(scanned).toEqual(["tree-0/a/f0.txt", "tree-0/a/f1.txt", "tree-0/b/f0.txt"]);
  });

  test("retry keeps failed attempts; runProgram retries throws until ok", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const tag = `img-${i}`;
      return trace(
        `rt-${i}`,
        [
          { name: "pushImage", args: { tag }, result: { error: "429 rate limited" }, ok: false },
          { name: "pushImage", args: { tag }, result: { error: "429 rate limited" }, ok: false },
          { name: "pushImage", args: { tag }, result: { pushed: true, tag }, ok: true },
          { name: "tagRelease", args: { tag }, result: { released: true, tag }, ok: true },
        ],
        { tag },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop" && s.until));
    expect(p, refusals.map((r) => r.reason).join("|")).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop" && s.until)!;
    expect(loop.kind === "loop" && loop.maxIters === 3).toBe(true);
    if (loop.kind === "loop") expect(loop.until).toMatch(/pushed == true|ok == true/);

    let n = 0;
    const tagged: string[] = [];
    const reg = registryFrom({
      pushImage: async ({ tag }) => {
        n++;
        if (n < 3) throw new Error("429 rate limited");
        return { pushed: true, tag };
      },
      tagRelease: async ({ tag }) => {
        tagged.push(String(tag));
        return { released: true };
      },
    });
    await runProgram(p!, { tag: "img-0" }, { registry: reg, checkEnvelope: false });
    expect(n).toBe(3);
    expect(tagged).toEqual(["img-0"]);
  });

  test("barcode+lotCode both bind from the item", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const wave = `wv-${i}`;
      const lots = [
        { barcode: `bc-${wave}-0`, lotCode: `lt-${wave}-0`, qty: 4 },
        { barcode: `bc-${wave}-1`, lotCode: `lt-${wave}-1`, qty: 2 },
        { barcode: `bc-${wave}-2`, lotCode: `lt-${wave}-2`, qty: 9 },
      ];
      return trace(
        `bc-${i}`,
        [
          { name: "listLots", args: { wave }, result: { lots }, ok: true },
          ...lots.map((lot) => ({
            name: "moveLot",
            args: { barcode: lot.barcode, lotCode: lot.lotCode },
            result: { moved: true, barcode: lot.barcode, lotCode: lot.lotCode },
            ok: true,
          })),
          { name: "closeWave", args: { wave }, result: { closed: true, wave }, ok: true },
        ],
        { wave },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p, refusals.map((r) => r.reason).join("|")).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop")!;
    const move = p!.steps.find((s) => s.kind === "tool" && s.tool === "moveLot");
    expect(loop.kind === "loop" && move && move.kind === "tool").toBe(true);
    if (loop.kind === "loop" && move && move.kind === "tool") {
      expect(move.args.barcode).toEqual({ kind: "from", step: loop.item, path: "barcode" });
      expect(move.args.lotCode).toEqual({ kind: "from", step: loop.item, path: "lotCode" });
    }
  });

  test("random non-prefix subset still refuses read_set_mismatch", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const hits = Array.from({ length: 12 }, (_, j) => `src/m${j}/impl.ts`);
      const read = [1, 3, 5, 7, 9, 11].map((j) => hits[j]!);
      return trace(
        `rnd-${i}`,
        [
          { name: "grepCode", args: { pattern: `p${i}` }, result: { hits }, ok: true },
          ...read.map((path) => ({ name: "readFile", args: { path }, result: { path, lines: ["ok"] }, ok: true })),
          { name: "writeNotes", args: { topic: `p${i}` }, result: { notesWritten: true }, ok: true },
        ],
        { topic: `p${i}` },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(programs.filter((p) => p.steps.some((s) => s.kind === "loop"))).toHaveLength(0);
    expect(refusals.find((r) => r.code === "read_set_mismatch" && r.readSet === 12 && r.repeats === 6)).toBeDefined();
  });
});
