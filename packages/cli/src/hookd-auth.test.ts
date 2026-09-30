import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHookdKey, hookdKeyMatches, hookdKeyPath, readHookdKey } from "./hookd-key";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.EDEN_HOME;
  home = mkdtempSync(join(tmpdir(), "eden-hookd-auth-"));
  process.env.EDEN_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.EDEN_HOME;
  else process.env.EDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("hookd key file (#85)", () => {
  test("is created once, 0600, as one header line, and reused", () => {
    expect(readHookdKey()).toBeNull();
    const key = ensureHookdKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(hookdKeyPath()).toBe(join(home, "hookd.key"));
    expect(statSync(hookdKeyPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(hookdKeyPath(), "utf8")).toBe(`x-eden-hookd-key: ${key}\n`);
    expect(ensureHookdKey()).toBe(key);
    expect(readHookdKey()).toBe(key);
  });

  test("a key file other accounts can read is not a key", () => {
    ensureHookdKey();
    chmodSync(hookdKeyPath(), 0o644);
    expect(readHookdKey()).toBeNull();
    expect(() => ensureHookdKey()).toThrow(/0600/);
  });

  test("a malformed key file is not a key", () => {
    writeFileSync(hookdKeyPath(), "x-eden-hookd-key: short\n", { mode: 0o600 });
    expect(readHookdKey()).toBeNull();
    expect(hookdKeyMatches("short")).toBe(false);
  });

  test("only the current key matches", () => {
    const key = ensureHookdKey();
    expect(hookdKeyMatches(key)).toBe(true);
    expect(hookdKeyMatches(null)).toBe(false);
    expect(hookdKeyMatches("")).toBe(false);
    expect(hookdKeyMatches(key.slice(1))).toBe(false);
    expect(hookdKeyMatches(`${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`)).toBe(false);
    rmSync(hookdKeyPath());
    expect(hookdKeyMatches(key)).toBe(false);
  });
});
