/**
 * P0.8: delivery-point flags (EXECUTION X7): precedence env > repo file > user file > default, unknown values, the
 * repo a folder belongs to (worktrees included), the circuit breaker's override, and the flag lifecycle.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAG_NAMES, FLAGS, readBreaker, repoTop, resolveFlags } from "./memory-flags";

let dir = "";
let home = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-flags-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

const env = (extra: Record<string, string> = {}) => ({ EDEN_HOME: home, ...extra });

describe("resolveFlags", () => {
  test("no file: every point at its default; the points built before flags existed stay on", () => {
    const state = resolveFlags(undefined, env());
    expect(state["deliver.submit"]).toEqual({ mode: "on", source: "default" });
    expect(state["deliver.session_start"]).toEqual({ mode: "on", source: "default" });
    expect(state["deliver.subagent"].mode).toBe("shadow");
    expect(state["guard.ask"].mode).toBe("off");
    expect(Object.keys(state)).toEqual(FLAG_NAMES);
  });

  test("env > repo file > user file > default", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(home, "flags.json"), { "deliver.submit": "off", "deliver.session_start": "shadow" });
    write(join(repo, ".eden", "flags.json"), { "deliver.submit": "shadow" });
    const inRepo = resolveFlags(join(repo, "src"), env());
    expect(inRepo["deliver.submit"]).toEqual({ mode: "shadow", source: "repo" });
    expect(inRepo["deliver.session_start"]).toEqual({ mode: "shadow", source: "user" });
    expect(resolveFlags(dir, env())["deliver.submit"]).toEqual({ mode: "off", source: "user" });
    const fromEnv = resolveFlags(join(repo, "src"), env({ EDEN_FLAG_DELIVER_SUBMIT: "on" }));
    expect(fromEnv["deliver.submit"]).toEqual({ mode: "on", source: "env" });
  });

  test("guard.ask reads EDEN_POLICY_GUARD", () => {
    expect(resolveFlags(undefined, env({ EDEN_POLICY_GUARD: "shadow" }))["guard.ask"]).toEqual({
      mode: "shadow",
      source: "env",
    });
  });

  test("an unknown value resolves to off, or shadow for deliver.submit, and is reported", () => {
    write(join(home, "flags.json"), { "deliver.submit": "yes please", "deliver.session_start": 1, "guard.ask": "ON" });
    const state = resolveFlags(undefined, env());
    expect(state["deliver.submit"]).toEqual({ mode: "shadow", source: "user", unknown: "yes please" });
    expect(state["deliver.session_start"]).toEqual({ mode: "off", source: "user", unknown: "1" });
    expect(state["guard.ask"]).toEqual({ mode: "on", source: "user" });
  });

  test("an unreadable or malformed file sets nothing", () => {
    write(join(home, "flags.json"), "{not json");
    expect(resolveFlags(undefined, env())["deliver.submit"]).toEqual({ mode: "on", source: "default" });
    write(join(home, "flags.json"), '["deliver.submit"]');
    expect(resolveFlags(undefined, env())["deliver.submit"]).toEqual({ mode: "on", source: "default" });
  });

  test("the breaker forces an on point to shadow until its time passes, and never raises one", () => {
    const now = Date.now();
    write(join(home, "flags.json"), { "deliver.session_start": "off" });
    write(join(home, "flags.auto.json"), {
      "deliver.submit": { mode: "shadow", since: now, until: now + 60_000, cause: "test", announced: false },
      "deliver.session_start": { mode: "shadow", since: now, until: now + 60_000, cause: "test", announced: false },
      "deliver.batch": { mode: "shadow", since: now - 9e7, until: now - 1, cause: "old", announced: true },
    });
    const state = resolveFlags(undefined, env());
    expect(state["deliver.submit"]).toEqual({ mode: "shadow", source: "breaker" });
    expect(state["deliver.session_start"]).toEqual({ mode: "off", source: "user" });
    expect(Object.keys(readBreaker(join(home, "flags.auto.json"), now))).toEqual([
      "deliver.submit",
      "deliver.session_start",
    ]);
  });
});

describe("repoTop", () => {
  test("the nearest folder holding .git; a linked worktree belongs to its main checkout", () => {
    const main = join(dir, "main");
    // A linked worktree's git dir names the common dir in its `commondir` file, as `git worktree add` writes it.
    write(join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
    mkdirSync(join(main, "packages", "cli"), { recursive: true });
    expect(repoTop(join(main, "packages", "cli"))).toBe(main);
    const linked = join(dir, "elsewhere", "feature");
    write(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
    expect(repoTop(join(linked))).toBe(main);
    const submodule = join(main, "vendor", "lib");
    write(join(submodule, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(repoTop(submodule)).toBe(submodule);
    expect(repoTop("relative/path")).toBeUndefined();
  });
});

describe("flag lifecycle (X7)", () => {
  test("every release flag has a removal date still ahead; the kill switch has none", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const flag of FLAG_NAMES) {
      const spec = FLAGS[flag];
      const removeBy = "removeBy" in spec ? spec.removeBy : undefined;
      if (flag === "guard.ask") {
        expect(removeBy).toBeUndefined();
        continue;
      }
      expect(removeBy, `${flag} has no removal date`).toBeDefined();
      expect(removeBy! > today, `${flag} is past its removal date ${removeBy}: remove the flag or move the date`).toBe(
        true,
      );
    }
  });
});
