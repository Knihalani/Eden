import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  archiveCli,
  archiveHelp,
  archiveStatus,
  compactArchive,
  compactHotFile,
  formatArchiveStatus,
} from "./archive";

describe("archival tiers", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.EDEN_HOME;
    home = join(import.meta.dir, "../../.tmp-eden-archive");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    delete process.env.EDEN_RETAIN_DAYS;
    delete process.env.EDEN_WARM_DAYS;
    delete process.env.EDEN_COLD_MONTHS;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    delete process.env.EDEN_RETAIN_DAYS;
    delete process.env.EDEN_WARM_DAYS;
    delete process.env.EDEN_COLD_MONTHS;
    rmSync(home, { recursive: true, force: true });
  });

  const age = (p: string, ms: number) => {
    const old = new Date(Date.now() - ms);
    utimesSync(p, old, old);
  };

  test("empty status is honest zeros", () => {
    const s = archiveStatus();
    expect(s.hot).toBe(0);
    expect(s.warm).toBe(0);
    expect(s.cold).toBe(0);
    const text = formatArchiveStatus(s);
    expect(text).toContain("hot   0 runs");
    expect(text).toContain("warm  0 receipts");
    expect(text).toContain("cold  0 months");
  });

  test("compactHotFile drops events and keeps id / tokenClasses / fleet fields", () => {
    const p = join(home, "runs", "run-1.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({
          id: "run-1",
          events: [{ tool: "lookup", args: { secret: "nope" } }, { tool: "write" }],
          tokenClasses: { compiled: 4, memoized: 1, transparent: 0, steeredSkip: 3, frontier: 2 },
          agentId: "agent-a",
          parentRunId: "parent-1",
          fleetId: "fleet-9",
          region: "us-east",
          at: 1_700_000_000_000,
        }),
      ].join("\n") + "\n",
    );
    const warm = compactHotFile(p, "run-1", Date.now());
    expect(warm.id).toBe("run-1");
    expect(warm.tokenClasses).toEqual({ compiled: 4, memoized: 1, transparent: 0, steeredSkip: 3, frontier: 2 });
    expect(warm.agentId).toBe("agent-a");
    expect(warm.parentRunId).toBe("parent-1");
    expect(warm.fleetId).toBe("fleet-9");
    expect(warm.region).toBe("us-east");
    expect(warm.at).toBe(1_700_000_000_000);
    expect(JSON.stringify(warm)).not.toContain("events");
    expect(JSON.stringify(warm)).not.toContain("secret");
  });

  test("round-trip compact: old hot → warm (no events); live hot still readable", () => {
    process.env.EDEN_RETAIN_DAYS = "1";
    process.env.EDEN_WARM_DAYS = "90";

    const oldPath = join(home, "runs", "old.jsonl");
    writeFileSync(
      oldPath,
      JSON.stringify({
        id: "old",
        events: [{ tool: "write", args: { body: "full" } }],
        tokenClasses: { compiled: 10, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 10 },
        agentId: "a1",
        at: Date.now() - 3 * 86_400_000,
      }) + "\n",
    );
    age(oldPath, 3 * 86_400_000);

    const livePath = join(home, "runs", "live.jsonl");
    const liveBody = JSON.stringify({ id: "live", events: [{ tool: "lookup" }], note: "still hot" }) + "\n";
    writeFileSync(livePath, liveBody);
    age(livePath, 2 * 3_600_000); // 2h — younger than retain

    const r = compactArchive();
    expect(r.ok).toBe(true);
    expect(r.hotToWarm).toBe(1);
    expect(r.liveHotKept).toBe(1);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(livePath)).toBe(true);
    expect(readFileSync(livePath, "utf8")).toBe(liveBody);
    expect(readFileSync(livePath, "utf8")).toContain("events");

    const warmFile = join(home, "archive", "warm", "receipts.jsonl");
    expect(existsSync(warmFile)).toBe(true);
    const warm = JSON.parse(readFileSync(warmFile, "utf8").trim()) as Record<string, unknown>;
    expect(warm.id).toBe("old");
    expect(warm.events).toBeUndefined();
    expect(warm.agentId).toBe("a1");
    expect(JSON.stringify(warm)).not.toContain("full");

    const s = archiveStatus();
    expect(s.hot).toBe(1);
    expect(s.warm).toBe(1);
  });

  test("compact does not delete a live hot file younger than retain", () => {
    process.env.EDEN_RETAIN_DAYS = "14";
    const live = join(home, "runs", "fresh.jsonl");
    writeFileSync(live, JSON.stringify({ id: "fresh", events: [1, 2, 3] }) + "\n");
    const r = compactArchive();
    expect(r.ok).toBe(true);
    expect(r.hotToWarm).toBe(0);
    expect(r.liveHotKept).toBe(1);
    expect(existsSync(live)).toBe(true);
    expect(readFileSync(live, "utf8")).toContain("events");
  });

  test("warm older than EDEN_WARM_DAYS folds into cold monthly DC+counts", () => {
    process.env.EDEN_RETAIN_DAYS = "1";
    process.env.EDEN_WARM_DAYS = "1";
    process.env.EDEN_COLD_MONTHS = "24";

    const oldPath = join(home, "runs", "aged.jsonl");
    const at = Date.now() - 10 * 86_400_000;
    writeFileSync(
      oldPath,
      JSON.stringify({
        id: "aged",
        events: [{ tool: "x" }],
        tokenClasses: { compiled: 8, memoized: 2, transparent: 0, steeredSkip: 0, frontier: 10 },
        at,
      }) + "\n",
    );
    age(oldPath, 10 * 86_400_000);

    const r = compactArchive();
    expect(r.ok).toBe(true);
    expect(r.hotToWarm).toBe(1);
    expect(r.warmToCold).toBe(1);
    expect(existsSync(oldPath)).toBe(false);

    const warmFile = join(home, "archive", "warm", "receipts.jsonl");
    expect(readFileSync(warmFile, "utf8").trim()).toBe("");

    const month = `${new Date(at).getUTCFullYear()}-${String(new Date(at).getUTCMonth() + 1).padStart(2, "0")}`;
    const coldFile = join(home, "archive", "cold", `${month}.jsonl`);
    expect(existsSync(coldFile)).toBe(true);
    const cold = JSON.parse(readFileSync(coldFile, "utf8").trim()) as {
      month: string;
      runs: number;
      dcShare: number;
      billed: number;
      classes: { compiled: number; frontier: number };
    };
    expect(cold.month).toBe(month);
    expect(cold.runs).toBe(1);
    expect(cold.billed).toBe(20);
    expect(cold.dcShare).toBe(10 / 20);
    expect(cold.classes.compiled).toBe(8);
    expect(JSON.stringify(cold)).not.toContain("events");

    const s = archiveStatus();
    expect(s.hot).toBe(0);
    expect(s.warm).toBe(0);
    expect(s.cold).toBe(1);
  });

  test("help lists status and compact", () => {
    expect(archiveHelp()).toContain("eden archive status");
    expect(archiveHelp()).toContain("eden archive compact");
  });

  test("archiveCli status prints honest zeros; compact is fail-open", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      expect(await archiveCli(["status"])).toBe(0);
      expect(await archiveCli(["--help"])).toBe(0);
    } finally {
      console.log = orig;
    }
    const joined = lines.join("\n");
    expect(joined).toContain("hot   0 runs");
    expect(joined).toContain("eden archive status");
    expect(await archiveCli(["compact"])).toBe(0);
  });
});
