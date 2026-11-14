import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PARTS } from "@eden/engine";
import { cardLimits, labConfig, parseFlags, type FlagSpec } from "./flags";
import { PRESETS } from "./presets";

const KNOWN: FlagSpec = { preset: "value", seeds: "value", set: "value", record: "bool", blind: "bool" };

describe("parseFlags (audit 2026-11-03b, devloop-lab-accepts-typos-silently)", () => {
  test("known flags parse; the first value of a repeated flag wins; `--` ends the flags", () => {
    const p = parseFlags(["--preset", "NEWL", "--record", "--preset", "H", "--", "--time", "1"], KNOWN);
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(p.values.get("preset")).toBe("NEWL");
    expect(p.bools.has("record")).toBe(true);
    expect(p.rest).toEqual(["--time", "1"]);
    // A value that starts with one dash (a negative number) or a brace is a value.
    const q = parseFlags(["--seeds", "-1", "--set", '{"probes":true}'], KNOWN);
    expect(q.kind === "ok" && q.values.get("set")).toBe('{"probes":true}');
  });

  test("an unknown flag, a stray argument or a missing value is an error; --help is help", () => {
    expect(parseFlags(["--presett", "NEWL"], KNOWN)).toEqual({
      kind: "error",
      message: "unknown flag --presett (did you mean --preset?)",
    });
    expect(parseFlags(["--sed", "41"], KNOWN)).toEqual({
      kind: "error",
      message: "unknown flag --sed (did you mean --set?)",
    });
    expect(parseFlags(["--bogus"], KNOWN)).toEqual({ kind: "error", message: "unknown flag --bogus" });
    expect(parseFlags(["train1"], KNOWN)).toEqual({ kind: "error", message: 'unexpected argument "train1"' });
    expect(parseFlags(["--preset"], KNOWN)).toEqual({ kind: "error", message: "--preset needs a value" });
    expect(parseFlags(["--preset", "--record"], KNOWN)).toEqual({ kind: "error", message: "--preset needs a value" });
    expect(parseFlags(["--record", "--help", "--bogus"], KNOWN)).toEqual({ kind: "help" });
    expect(parseFlags(["-h"], KNOWN)).toEqual({ kind: "help" });
  });
});

describe("labConfig: the lab's presets and overrides through checkEngineConfig", () => {
  test("every preset passes as it stands", () => {
    // `default`, `minus-all` and one `minus-<part>` per part (D112).
    expect(Object.keys(PRESETS).length).toBe(2 + Object.keys(PARTS).length);
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(() => labConfig(preset, name)).not.toThrow();
    }
  });

  test("a child flag is checked on the merged preset and override", () => {
    // The default turns sync on, so its child is accepted; an override turning sync off leaves a child set on doing
    // nothing, while minus-sync's own values (the core's) take the part out cleanly.
    expect(labConfig({ ...PRESETS.default, syncPollBehind: true }, "default").syncPollBehind).toBe(true);
    expect(labConfig({ ...PRESETS.default, syncPollPageSize: 7 }, "default").syncPollPageSize).toBe(7);
    expect(() => labConfig({ ...PRESETS["minus-sync"], syncPollPageSize: 7 }, "minus-sync")).toThrow(
      /"syncPollPageSize" acts only/,
    );
    expect(labConfig({ ...PRESETS["minus-sync"] }, "minus-sync").sync).toBe(false);
    expect(() => labConfig({ ...PRESETS.default, fallbackAsk: true }, "default")).toThrow(/unknown key "fallbackAsk"/);
  });
});

// One spawned smoke per CLI: each exits 2 on a misspelled flag before building anything (in parallel, ~0.3 s).
test("funnel, hidden-funnel and quality-cli exit 2 on a misspelled flag without running", async () => {
  const root = join(import.meta.dir, "..", "..", "..", "..");
  const runs = [
    ["packages/sim/src/lab/funnel.ts", "--presett", "NEWL"],
    ["packages/sim/src/lab/hidden-funnel.ts", "--sed", "41"],
    ["packages/sim/src/quality-cli.ts", "--bogus"],
  ].map(async (args) => {
    const child = Bun.spawn(["bun", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, err };
  });
  for (const { code, err } of await Promise.all(runs)) {
    expect(code).toBe(2);
    expect(err).toMatch(/unknown flag --/);
  }
});

describe("--card-limits", () => {
  test("gatherMs: null is no cut (Infinity), a positive number stands, anything else is refused by name", () => {
    expect(cardLimits('{"gatherMs":null,"batch":20}')).toEqual({ gatherMs: Infinity, batch: 20 });
    expect(cardLimits('{"gatherMs":50}')).toEqual({ gatherMs: 50 });
    expect(cardLimits("{}")).toEqual({});
    // A typo used to reach the drain's gather and act as no cut at all.
    for (const bad of ['"x"', "0", "-5", "true", "1e999", "{}"]) {
      expect(() => cardLimits(`{"gatherMs":${bad}}`)).toThrow("gatherMs must be null (no cut) or a positive number");
    }
    expect(() => cardLimits("[1]")).toThrow("must be an object");
    expect(() => cardLimits("{gatherMs:1}")).toThrow("--card-limits is not JSON");
  });
});
