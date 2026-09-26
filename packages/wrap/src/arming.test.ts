import { describe, expect, test } from "bun:test";
import {
  ARM_MAX_PER_SESSION,
  ARM_TTL_MS,
  armExpired,
  createArmingStore,
  hintIdOf,
  mightClaim,
  restCounts,
  type Armed,
} from "./arming";
import { isProgramReadOnly, wrapAgentId, wrapFleetId, wrapRegion } from "./fleet";
import { withVersion, type StretchProgram } from "@eden/ir";

function fakeArmed(over: Partial<Armed> = {}): Armed {
  let resolveSettled!: (ok: boolean) => void;
  const settled = new Promise<boolean>((r) => (resolveSettled = r));
  const rest = over.rest ?? new Map([["write", 1]]);
  const input = over.input ?? { id: "E-1" };
  return {
    rest,
    input,
    programId: "p",
    armedAt: performance.now(),
    armedAtCall: 0,
    budgetCalls: 8,
    matchedCalls: 0,
    settled,
    resolveSettled,
    closed: false,
    hintId: hintIdOf(input),
    ...over,
  };
}

describe("arming store", () => {
  test("partitions by session — identical entity ids do not share suppressions", () => {
    const s = createArmingStore();
    expect(s.insert("a", "k1", fakeArmed({ input: { id: "E-1" } }))).toBe(true);
    expect(s.insert("b", "k1", fakeArmed({ input: { id: "E-1" } }))).toBe(true);
    expect(s.sessionSize("a")).toBe(1);
    expect(s.sessionSize("b")).toBe(1);
    expect(s.globalSize()).toBe(2);
    expect(s.scan("a", "write", { id: "E-1" }, performance.now()).map(([k]) => k)).toEqual(["k1"]);
    expect(s.scan("b", "write", { id: "E-1" }, performance.now()).map(([k]) => k)).toEqual(["k1"]);
    s.delete("a", "k1");
    expect(s.scan("b", "write", { id: "E-1" }, performance.now()).length).toBe(1);
    expect(s.sessionSize("a")).toBe(0);
  });

  test("per-session cap fail-opens; does not steal the other session's live arming", () => {
    const s = createArmingStore({ perSessionMax: 2, globalMax: 8 });
    expect(s.insert("a", "1", fakeArmed())).toBe(true);
    expect(s.insert("a", "2", fakeArmed())).toBe(true);
    expect(s.insert("a", "3", fakeArmed())).toBe(false);
    expect(s.stats().rejects).toBe(1);
    expect(s.insert("b", "1", fakeArmed())).toBe(true);
    expect(s.sessionSize("a")).toBe(2);
    expect(s.sessionSize("b")).toBe(1);
  });

  test("global cap fail-opens rather than evicting live armings", () => {
    const s = createArmingStore({ perSessionMax: 8, globalMax: 2 });
    expect(s.insert("a", "1", fakeArmed())).toBe(true);
    expect(s.insert("b", "1", fakeArmed())).toBe(true);
    expect(s.insert("c", "1", fakeArmed())).toBe(false);
    expect(s.globalSize()).toBe(2);
  });

  test("scan is newest-first", () => {
    const s = createArmingStore();
    s.insert("", "old", fakeArmed({ input: { id: "E-1" }, rest: new Map([["write", 1]]) }));
    s.insert("", "new", fakeArmed({ input: { id: "E-2" }, rest: new Map([["write", 1]]) }));
    const keys = s.scan("", "write", { id: "E-2" }, performance.now()).map(([k]) => k);
    expect(s.all("", performance.now()).map(([k]) => k)).toEqual(["new", "old"]);
    expect(keys).toEqual(["new"]);
  });

  test("in-flight heads do not TTL-expire", () => {
    const live = fakeArmed({ closed: false, armedAt: performance.now() - ARM_TTL_MS * 3 });
    expect(armExpired(live, performance.now())).toBe(false);
    live.closed = true;
    expect(armExpired(live, performance.now())).toBe(true);
  });

  test("mightClaim skips extractInput on idle ping vs 64 id-armed tails", () => {
    const a = fakeArmed({ input: { id: "E-9" }, rest: new Map([["write", 1]]) });
    expect(mightClaim(a, "ping", {})).toBe(false);
    expect(mightClaim(a, "write", { id: "E-8" })).toBe(false);
    expect(mightClaim(a, "write", { id: "E-9" })).toBe(true);
    expect(mightClaim(a, "audit", { id: "E-9" })).toBe(true);
  });

  test("default per-session cap is 64", () => {
    expect(ARM_MAX_PER_SESSION).toBe(64);
    const s = createArmingStore();
    expect(s.perSessionMax).toBe(64);
  });

  test("restCounts is the tail, not the head", () => {
    const p = withVersion({
      id: "p",
      name: "p",
      description: "d",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      sequence: ["lookup", "write", "audit"],
      steps: [],
      returns: { kind: "from", step: "audit", path: "" },
      contract: { witnesses: 1, minLlmReduction: 1, allowExact: true },
      manifest: null,
    }) as StretchProgram;
    const r = restCounts(p);
    expect(r.get("lookup")).toBeUndefined();
    expect(r.get("write")).toBe(1);
    expect(r.get("audit")).toBe(1);
  });

  test("scanFleet returns only read-only armings in that fleet", () => {
    const s = createArmingStore();
    const ro = fakeArmed({
      input: { id: "E-1" },
      rest: new Map([["fetchComments", 1]]),
      readOnly: true,
      fleetId: "f1",
    });
    const mut = fakeArmed({
      input: { id: "E-1" },
      rest: new Map([["write", 1]]),
      fleetId: "f1",
    });
    expect(s.insert("a", "ro", ro)).toBe(true);
    expect(s.insert("b", "mut", mut)).toBe(true);
    const now = performance.now();
    expect(s.scan("a", "write", { id: "E-1" }, now).map(([k]) => k)).toEqual(["ro"]);
    expect(s.scan("b", "write", { id: "E-1" }, now).map(([k]) => k)).toEqual(["mut"]);
    expect(s.scanFleet("f1", "fetchComments", { id: "E-1" }, now).map((h) => h.key)).toEqual(["ro"]);
    expect(s.scanFleet("f1", "write", { id: "E-1" }, now).every((h) => h.armed.readOnly === true)).toBe(true);
    expect(s.scanFleet("", "fetchComments", { id: "E-1" }, now)).toEqual([]);
    expect(s.scanFleet("other", "fetchComments", { id: "E-1" }, now)).toEqual([]);
  });

  test("scan still does not walk other sessions when a fleet arming exists", () => {
    const s = createArmingStore();
    s.insert(
      "a",
      "k",
      fakeArmed({ input: { id: "E-1" }, rest: new Map([["fetchComments", 1]]), readOnly: true, fleetId: "f1" }),
    );
    const now = performance.now();
    expect(s.scan("b", "fetchComments", { id: "E-1" }, now)).toEqual([]);
    expect(s.scanFleet("f1", "fetchComments", { id: "E-1" }, now)).toHaveLength(1);
  });

  test("isProgramReadOnly requires every name to be a read and none mutating", () => {
    const reads = withVersion({
      id: "r",
      name: "r",
      description: "d",
      inputSchema: { type: "object" },
      sequence: ["fetchIssue", "fetchComments"],
      steps: [],
      returns: { kind: "from", step: "fetchComments", path: "" },
      contract: { witnesses: 1, minLlmReduction: 1, allowExact: true },
      manifest: null,
    }) as StretchProgram;
    const writes = withVersion({
      id: "w",
      name: "w",
      description: "d",
      inputSchema: { type: "object" },
      sequence: ["lookup", "write"],
      steps: [],
      returns: { kind: "from", step: "write", path: "" },
      contract: { witnesses: 1, minLlmReduction: 1, allowExact: true },
      manifest: null,
    }) as StretchProgram;
    expect(isProgramReadOnly(reads)).toBe(true);
    expect(isProgramReadOnly(writes)).toBe(false);
  });

  test("empty fleet/agent/region helpers default to no sharing", () => {
    expect(wrapFleetId()).toBe("");
    expect(wrapAgentId(undefined, "sess")).toBe("sess");
    expect(wrapRegion()).toBe("");
  });
});
