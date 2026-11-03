import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { labConfig, parseFlags, type FlagSpec } from "./flags";
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
    expect(Object.keys(PRESETS).length).toBe(10);
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(() => labConfig(preset, name)).not.toThrow();
    }
  });

  test("a child flag is checked on the merged preset and override", () => {
    // ALL3 turns sync on, so its child is accepted; an override turning sync off leaves the child doing nothing. (The
    // unified default turns sync and syncPollBehind on, D111, so the child is set off its default here.)
    expect(labConfig({ ...PRESETS.ALL3, syncPollBehind: true }, "ALL3").syncPollBehind).toBe(true);
    expect(labConfig({ ...PRESETS.ALL3, syncPollPageSize: 7 }, "ALL3").syncPollPageSize).toBe(7);
    expect(() => labConfig({ ...PRESETS.H, sync: false, syncPollPageSize: 7 }, "H")).toThrow(
      /"syncPollPageSize" acts only/,
    );
    expect(() => labConfig({ ...PRESETS.ALL3, fallbackAsk: true }, "ALL3")).toThrow(/unknown key "fallbackAsk"/);
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
