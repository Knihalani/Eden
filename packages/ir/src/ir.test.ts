import { describe, expect, test } from "bun:test";
import { canonicalize, cloneJson, containsRedaction, eq, flatten, getPath, hashProgram, hashTrace, inDistribution, interpolate, isWeakValue, minLlmReductionOf, redact, redactString, validateProgram, withVersion } from "../src/index";
import type { StretchProgram } from "../src/index";

const mini = (): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
    manifest: null,
  });

describe("ir", () => {
  test("rejects unknown step kind", () => {
    const p = mini();
    // "wasm" is intentionally not a real step kind — this is the input validateProgram must reject.
    (p as { steps: object[] }).steps = [{ id: "a", kind: "wasm", tool: "x", args: {} }];
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("unknown step kind"))).toBe(true);
  });

  test("rejects unknown from.step", () => {
    const p = mini();
    (p.steps[0] as { args: Record<string, unknown> }).args.id = { kind: "from", step: "missing", path: "" };
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("unknown step missing"))).toBe(true);
  });

  test("rejects unknown binding kind", () => {
    const p = mini();
    (p.steps[0] as { args: Record<string, unknown> }).args.id = { kind: "cegis", value: 1 };
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("unknown binding kind"))).toBe(true);
  });

  test("hash is stable under key reorder", () => {
    const a = hashProgram(mini());
    const b = hashProgram(JSON.parse(canonicalize(mini())) as StretchProgram);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("minLlmReduction defaults to 2×", () => {
    expect(minLlmReductionOf(undefined)).toBe(2);
    expect(minLlmReductionOf(NaN)).toBe(2);
    expect(minLlmReductionOf(0)).toBe(2);
    expect(minLlmReductionOf(2)).toBe(2);
    expect(minLlmReductionOf(5)).toBe(5);
  });

  test("hashTrace is content-addressed and ignores trace id", () => {
    const events = [{ name: "lookup", args: { id: "T-100" }, result: { ok: true }, ok: true }];
    const a = hashTrace({ events, input: { id: "T-100" } });
    const b = hashTrace({ events: [...events], input: { id: "T-100" } });
    const c = hashTrace({ events, input: { id: "T-101" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
    const wired = hashTrace(JSON.parse(JSON.stringify({ events, input: { id: "T-100", skip: undefined } })));
    expect(hashTrace({ events, input: { id: "T-100", skip: undefined } })).toBe(wired);
  });

  test("getPath and eq", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({ a: { b: 1 } }, "$.a.b")).toBe(1);
    expect(eq({ a: 1 }, { a: 1 })).toBe(true);
    expect(eq({ a: 1 }, { a: 2 })).toBe(false);
  });

  test("cloneJson deep-copies objects", () => {
    const src = { a: { b: 1 } };
    const copy = cloneJson(src);
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    copy.a.b = 2;
    expect(src.a.b).toBe(1);
  });

  test("interpolate fills {path} from an object", () => {
    expect(interpolate("hi {id}", { id: "T-100" })).toBe("hi T-100");
    expect(interpolate("hi ${id}", { id: "T-100" })).toBe("hi T-100");
  });

  test("weak values", () => {
    expect(isWeakValue(true)).toBe(true);
    expect(isWeakValue("T-100")).toBe(false);
    expect(isWeakValue(0)).toBe(true);
  });

  test("redacts bearer, api_key, password", () => {
    const red = redact({
      authorization: "Bearer abc.def",
      api_key: "sk-secret",
      password: "hunter2",
      "x-api-key": "hdr-secret",
      jwt: "eyJhbGciOi",
      cookie: "sid=abc",
      "set-cookie": "sid=abc",
      "x-auth-token": "hdr",
      note: "Bearer tok_live_123 and api_key=xyz password=nope stay gone",
      ok: "hello",
    }) as Record<string, unknown>;
    expect(red.authorization).toBe("[REDACTED]");
    expect(red.api_key).toBe("[REDACTED]");
    expect(red.password).toBe("[REDACTED]");
    expect(red["x-api-key"]).toBe("[REDACTED]");
    expect(red.jwt).toBe("[REDACTED]");
    expect(red.cookie).toBe("[REDACTED]");
    expect(red["set-cookie"]).toBe("[REDACTED]");
    expect(red["x-auth-token"]).toBe("[REDACTED]");
    expect(red.ok).toBe("hello");
    expect(String(red.note)).not.toContain("tok_live");
    expect(String(red.note)).not.toContain("xyz");
    expect(String(red.note)).not.toContain("nope");
    expect(JSON.stringify(red)).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(JSON.stringify(red).toLowerCase()).not.toContain("hunter2");
    expect(JSON.stringify(red).toLowerCase()).not.toContain("sk-secret");
  });

  test("no envelope is out of distribution unless allowExact", () => {
    const p = mini();
    expect(inDistribution(p, { id: "T-100" })).toBe(false);
    const exact = { ...mini(), contract: { ...mini().contract, allowExact: true } };
    expect(inDistribution(exact, { id: "T-100" })).toBe(true);
  });

  test("eq requires matching keys and rejects non-plain objects", () => {
    expect(eq({ a: undefined }, { b: undefined })).toBe(false);
    expect(eq(new Date(1), new Date(2))).toBe(false);
    expect(eq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  test("canonicalize distinguishes NaN from null and undefined", () => {
    expect(canonicalize(NaN)).toBe("NaN");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(undefined)).toBe("undefined");
  });

  test("redact handles cycles, secretKey, and github tokens", () => {
    const cyclic: Record<string, unknown> = { secretKey: "abc" };
    cyclic.self = cyclic;
    const red = redact(cyclic) as Record<string, unknown>;
    expect(red.secretKey).toBe("[REDACTED]");
    // A back-edge is a cycle, not a credential: they get distinct sentinels so
    // that containsRedaction() cannot mistake a self-referential payload for a
    // secret and refuse an otherwise bindable slot.
    expect(red.self).toBe("[CYCLE]");
    expect(redactString("token ghp_abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  test("redact expands shared references instead of collapsing them", () => {
    const shared = { name: "bug", nested: { k: "v" } };
    const red = redact({ a: shared, b: shared }) as Record<string, unknown>;
    expect(red.a).toEqual({ name: "bug", nested: { k: "v" } });
    // Reachable twice is not a cycle. Collapsing the second branch would delete
    // real data from the trace before it ever reaches the compiler.
    expect(red.b).toEqual({ name: "bug", nested: { k: "v" } });
  });

  test("canonicalize is insensitive to reference sharing", () => {
    const shared = { n: 1, deep: { k: "v" } };
    // Deeply equal values must produce identical canonical forms whether or not
    // they happen to be the same object; hashes and agreement() depend on it.
    expect(canonicalize({ a: shared, b: shared })).toBe(
      canonicalize({ a: { n: 1, deep: { k: "v" } }, b: { n: 1, deep: { k: "v" } } }),
    );
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(canonicalize(cyclic)).toBe('{"a":1,"self":"$cycle"}');
  });

  test("containsRedaction finds the sentinel at depth", () => {
    expect(containsRedaction({ headers: { authorization: "[REDACTED]" } })).toBe(true);
    expect(containsRedaction([{ a: 1 }, { b: ["[REDACTED]"] }])).toBe(true);
    expect(containsRedaction({ a: 1, b: ["fine", { c: null }] })).toBe(false);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(containsRedaction(cyclic)).toBe(false);
  });

  test("flatten expands a value reachable by two paths", () => {
    const label = { id: 7, name: "bug" };
    const paths = [...flatten({ first: label, second: label }).keys()];
    // Without both sub-trees, producersFor() cannot see that an argument came
    // from `second.id`, and a determinable slot degrades into a refusal.
    expect(paths).toContain("first.id");
    expect(paths).toContain("second.id");
    expect(paths).toContain("second.name");
  });

  test("getPath rejects prototype paths and invalid dots", () => {
    expect(getPath({ x: 1 }, "__proto__")).toBeUndefined();
    expect(getPath({ a: { b: 1 } }, "a..b")).toBeUndefined();
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
  });

  test("envelope values must be arrays", () => {
    const p = mini();
    p.contract.envelope = { inputs: { id: "T-1" as unknown as unknown[] } };
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("array"))).toBe(true);
    expect(inDistribution({ ...p, contract: { ...p.contract, envelope: { inputs: { id: "T-1" as unknown as unknown[] } } } }, { id: "T-1" })).toBe(false);
  });
});
