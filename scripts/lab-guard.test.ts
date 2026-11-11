import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { refusal } from "./lab-guard";

describe("lab-guard (bunfig.toml's preload)", () => {
  const lab = "/repo/packages/sim/src/lab/pi-ab.ts";
  test("a lab script with OPENROUTER_API_KEY set is refused, unless EDEN_ALLOW_OPENROUTER=1", () => {
    expect(refusal(lab, { OPENROUTER_API_KEY: "x" })).toContain("unset OPENROUTER_API_KEY");
    expect(refusal(lab, { OPENROUTER_API_KEY: "x", EDEN_ALLOW_OPENROUTER: "1" })).toBeNull();
    expect(refusal(lab, {})).toBeNull();
    expect(refusal(lab, { OPENROUTER_API_KEY: "" })).toBeNull();
  });

  test("product paths and the eval are not lab scripts", () => {
    for (const entry of ["/repo/packages/server/src/main.ts", "/repo/packages/eval/src/cli.ts", ""]) {
      expect(refusal(entry, { OPENROUTER_API_KEY: "x" })).toBeNull();
    }
  });

  test("the preload stops a real lab script before it runs, and lets it run without the key", () => {
    const root = join(import.meta.dir, "..");
    const run = (env: Record<string, string>) =>
      Bun.spawnSync(["bun", "packages/sim/src/lab/funnel.ts", "--help"], {
        cwd: root,
        env: { ...process.env, ...env },
      });
    // A placeholder, never a real key: the refused process makes no call either way.
    const refused = run({ OPENROUTER_API_KEY: "placeholder" });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain("EDEN_ALLOW_OPENROUTER");
    expect(run({ OPENROUTER_API_KEY: "" }).exitCode).toBe(0);
  });
});
