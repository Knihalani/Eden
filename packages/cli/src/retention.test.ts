import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, closeSync, openSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome } from "./home";

describe("runs retention sweep", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.EDEN_HOME;
    home = join(import.meta.dir, "../../.tmp-eden-retention");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    delete process.env.EDEN_RETAIN_DAYS;
    rmSync(home, { recursive: true, force: true });
  });

  const age = (p: string, ms: number) => {
    const old = new Date(Date.now() - ms);
    utimesSync(p, old, old);
  };

  test("empty shells older than an hour are removed with their sidecars", () => {
    const shell = join(home, "runs", "s1.jsonl");
    closeSync(openSync(shell, "w")); // empty
    writeFileSync(join(home, "runs", "s1.lock"), "");
    writeFileSync(join(home, "runs", "s1.cursor"), "{}");
    age(shell, 2 * 3_600_000);

    ensureHome();
    expect(existsSync(shell)).toBe(false);
    expect(existsSync(join(home, "runs", "s1.lock"))).toBe(false);
    expect(existsSync(join(home, "runs", "s1.cursor"))).toBe(false);
  });

  test("non-empty logs younger than the retain window survive", () => {
    const log = join(home, "runs", "live.jsonl");
    writeFileSync(log, JSON.stringify({ id: "a" }) + "\n");
    age(log, 2 * 3_600_000); // 2h old, non-empty → kept

    ensureHome();
    expect(existsSync(log)).toBe(true);
  });

  test("logs past EDEN_RETAIN_DAYS are swept even when non-empty", () => {
    process.env.EDEN_RETAIN_DAYS = "1";
    const log = join(home, "runs", "dead.jsonl");
    writeFileSync(log, JSON.stringify({ id: "old" }) + "\n");
    age(log, 2 * 86_400_000);

    ensureHome();
    expect(existsSync(log)).toBe(false);
  });

  test("orphaned sidecars without their log are garbage-collected", () => {
    writeFileSync(join(home, "runs", "ghost.lock"), "");
    writeFileSync(join(home, "runs", "ghost.cursor"), "5");
    ensureHome();
    expect(existsSync(join(home, "runs", "ghost.lock"))).toBe(false);
    expect(existsSync(join(home, "runs", "ghost.cursor"))).toBe(false);
  });
});
