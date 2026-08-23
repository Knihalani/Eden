import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { login, formatStatus } from "./login";
import { wrapRegistry, wrapListen } from "./wrap-cmd";
import { resolveApiKey } from "./home";

describe("login", () => {
  test("writes config", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-login");
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    await login(["--key", "eden_dev", "--url", "http://127.0.0.1:8788"]);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.api_key).toBe("eden_dev");
    expect(cfg.base_url).toBe("http://127.0.0.1:8788");
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses the default eden_dev key unless --dev", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-login-nodev");
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    const prev = process.env.EDEN_API_KEY;
    delete process.env.EDEN_API_KEY;
    await expect(login(["--url", "http://127.0.0.1:8788"])).rejects.toThrow(/--dev/);
    await login(["--dev", "--url", "http://127.0.0.1:8788"]);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.api_key).toBe("eden_dev");
    if (prev !== undefined) process.env.EDEN_API_KEY = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("formatStatus includes trace and live counts", () => {
    expect(formatStatus("http://x", "eden_dev", { ok: true, traces: 4, live: 1 })).toContain("traces 4");
    expect(formatStatus("http://x", "eden_dev", { ok: true, traces: 4, live: 1, fails: 2 })).toContain("fails 2");
    expect(formatStatus("http://x", "eden_dev", { ok: true, traces: 4, live: 1, savings: { tokensSavedMean: 420 } })).toContain("420 tokens saved");
    expect(formatStatus("http://x", "eden_dev", null)).toContain("down");
  });

  test("formatStatus prints a fingerprint, never a fragment of the key itself", () => {
    for (const health of [null, { ok: true, traces: 4, live: 1 }]) {
      const out = formatStatus("http://x", "eden_dev_secret_value_123456", health as never);
      // First-12-hex SHA-256 fingerprint identifies the key without leaking
      // any of its characters.
      expect(out).toMatch(/key [0-9a-f]{12}( |$)/);
      expect(out).not.toContain("eden_dev_secret");
      expect(out).not.toContain("123456");
    }
  });
});

describe("resolveApiKey", () => {
  test("refuses a silent eden_dev default", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-nokey");
    mkdirSync(home, { recursive: true });
    const prevKey = process.env.EDEN_API_KEY;
    const prevDev = process.env.EDEN_DEV;
    const prevHome = process.env.EDEN_HOME;
    delete process.env.EDEN_API_KEY;
    delete process.env.EDEN_DEV;
    process.env.EDEN_HOME = home;
    expect(() => resolveApiKey([])).toThrow(/--dev/);
    expect(resolveApiKey(["--dev"])).toBe("eden_dev");
    if (prevKey !== undefined) process.env.EDEN_API_KEY = prevKey;
    else delete process.env.EDEN_API_KEY;
    if (prevDev !== undefined) process.env.EDEN_DEV = prevDev;
    else delete process.env.EDEN_DEV;
    if (prevHome !== undefined) process.env.EDEN_HOME = prevHome;
    else delete process.env.EDEN_HOME;
    rmSync(home, { recursive: true, force: true });
  });
});

describe("wrap cmd", () => {
  test("--no-coding skips the coding registry", () => {
    expect(wrapRegistry(["--no-coding"])).toBeUndefined();
    expect(wrapRegistry([])?.has?.("Read")).toBe(true);
    expect(wrapRegistry([])?.has?.("Grep")).toBe(true);
    expect(wrapListen(["--host", "0.0.0.0", "--port", "9000"])).toEqual({ port: 9000, hostname: "0.0.0.0" });
    expect(wrapListen([]).hostname).toBe("127.0.0.1");
  });
});
