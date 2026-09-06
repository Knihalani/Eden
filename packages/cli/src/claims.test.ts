import { describe, expect, test } from "bun:test";
import { claimsCli, claimsHelp } from "./claims";
import { renderClaimsBoard } from "@eden/measure";

describe("eden claims", () => {
  test("help names the board", () => {
    expect(claimsHelp()).toMatch(/published limits board/);
    expect(claimsHelp()).toMatch(/not a live Claude Code invoice/);
  });

  test("letter matches the renderer; --kind limit omits wins; bad kind exits 1", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ""));
    };
    console.error = (msg?: unknown) => {
      errs.push(String(msg ?? ""));
    };
    try {
      expect(await claimsCli([])).toBe(0);
      expect(logs.join("\n")).toBe(renderClaimsBoard());
      logs.length = 0;
      expect(await claimsCli(["--kind", "limit"])).toBe(0);
      expect(logs.join("\n")).toMatch(/oblivious-long/);
      expect(logs.join("\n")).not.toMatch(/^WINS$/m);
      logs.length = 0;
      expect(await claimsCli(["--json"])).toBe(0);
      const rows = JSON.parse(logs.join("\n")) as Array<{ id: string; kind: string }>;
      expect(rows.some((r) => r.id === "oblivious-long" && r.kind === "limit")).toBe(true);
      expect(rows.some((r) => r.kind === "win" && r.id === "oblivious-long")).toBe(false);
      logs.length = 0;
      expect(await claimsCli(["--kind", "nope"])).toBe(1);
      expect(errs.join("\n")).toMatch(/unknown --kind/);
      logs.length = 0;
      expect(await claimsCli(["--help"])).toBe(0);
      expect(logs.join("\n")).toMatch(/eden claims/);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
