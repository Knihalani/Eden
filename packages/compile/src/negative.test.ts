import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { compileTraces, isPollName, normalizeTrace, stripNegativeSpace } from "./index";

function status(id: string, s: "pending" | "done", extra?: Record<string, unknown>) {
  return {
    name: "get_status",
    args: { id },
    result: { id, status: s, ...extra },
    ok: true as const,
  };
}

describe("negative-space compilation", () => {
  test("isPollName is status/poll/wait, not foreach reads", () => {
    expect(isPollName("get_status")).toBe(true);
    expect(isPollName("getStatus")).toBe(true);
    expect(isPollName("poll_ci")).toBe(true);
    expect(isPollName("listAll")).toBe(false);
    expect(isPollName("getItem")).toBe(false);
    expect(isPollName("writeItem")).toBe(false);
  });

  test("unused pending→pending→done drops every poll — program does not believe pending", () => {
    const events = [
      { name: "get_job", args: { id: "J-1" }, result: { id: "J-1" }, ok: true },
      status("J-1", "pending"),
      status("J-1", "pending"),
      status("J-1", "done"),
      { name: "notify", args: { id: "J-1" }, result: { notified: true }, ok: true },
    ];
    const stripped = stripNegativeSpace(events, { id: "J-1" });
    expect(stripped.map((e) => e.name)).toEqual(["get_job", "notify"]);
    expect(stripped.some((e) => (e.result as { status?: string })?.status === "pending")).toBe(false);

    const t = normalizeTrace({
      id: "p0",
      llmCalls: 5,
      duration_ms: 50,
      cost_cents: 5,
      input: { id: "J-1" },
      events,
    });
    expect(t.events.map((e) => e.name)).toEqual(["get_job", "notify"]);
    expect(t.events.some((e) => e.name === "get_status")).toBe(false);
  });

  test("a later bind from the poll keeps only the last call (done, not pending)", () => {
    const events = [
      { name: "get_job", args: { id: "J-2" }, result: { id: "J-2" }, ok: true },
      status("J-2", "pending"),
      status("J-2", "pending"),
      status("J-2", "done", { sha: "deadbeef" }),
      { name: "merge", args: { sha: "deadbeef" }, result: { merged: true }, ok: true },
      { name: "notify", args: { id: "J-2" }, result: { notified: true }, ok: true },
    ];
    const stripped = stripNegativeSpace(events, { id: "J-2" });
    const polls = stripped.filter((e) => e.name === "get_status");
    expect(polls).toHaveLength(1);
    expect((polls[0]!.result as { status: string }).status).toBe("done");
    expect((polls[0]!.result as { sha: string }).sha).toBe("deadbeef");
    expect(stripped.filter((e) => (e.result as { status?: string })?.status === "pending")).toEqual([]);
  });

  test("does not strip bindable foreach (listAll + per-item write)", () => {
    const items = ["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"];
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `fe${i}`,
      llmCalls: 8,
      duration_ms: 80,
      cost_cents: 8,
      complete: true,
      input: { batch: `B${i}` },
      output: { sealed: true },
      events: [
        { name: "listAll", args: { batch: `B${i}` }, result: { items }, ok: true },
        ...items.flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
        ]),
        { name: "sealBatch", args: { batch: `B${i}` }, result: { sealed: true }, ok: true },
      ],
    }));
    const before = traces[0]!.events.filter((e) => e.name === "writeItem").length;
    const normalized = normalizeTrace(traces[0]!);
    expect(normalized.events.filter((e) => e.name === "writeItem")).toHaveLength(before);
    expect(normalized.events.filter((e) => e.name === "listAll")).toHaveLength(1);

    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    expect(programs[0]!.steps.some((s) => s.kind === "loop")).toBe(true);
  });

  test("unique-work still refuses — nothing repeating is not a poll to strip", () => {
    const traces: StretchTrace[] = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`,
      llmCalls: 3,
      duration_ms: 10,
      cost_cents: 3,
      input: { id: `x${i}` },
      events: [
        { name: `toolA${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
        { name: `toolB${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
        { name: `toolC${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
      ],
    }));
    const { programs, refusals } = compileTraces(traces);
    expect(programs.length).toBe(0);
    expect(refusals).toEqual([]);
  });

  test("identical leftover reads still collapse; unused wait is gone", () => {
    const t = normalizeTrace({
      id: "dup",
      llmCalls: 3,
      duration_ms: 10,
      cost_cents: 3,
      input: { id: "A-1" },
      events: [
        { name: "getAccount", args: { id: "A-1" }, result: { id: "A-1", mrr: 400 }, ok: true },
        { name: "getAccount", args: { id: "A-1" }, result: { id: "A-1", mrr: 400 }, ok: true },
        { name: "notify", args: { id: "A-1" }, result: { notified: true }, ok: true },
      ],
    });
    expect(t.events.filter((e) => e.name === "getAccount")).toHaveLength(1);
  });
});
