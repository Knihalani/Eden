import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectDoctor, formatDoctor } from "./doctor";

describe("doctor", () => {
  test("reports wrap, hookd, config, and live-tools from a fake home", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    writeFileSync(join(home, "live-tools.json"), "[]");
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 2, live: 1 }));
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "config")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "wrap")?.detail).toContain("traces 2");
      expect(checks.find((c) => c.name === "hookd")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "live-tools")?.ok).toBe(true);
      expect(formatDoctor(checks)).toContain("ok  wrap:");
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("probes wrap on 8788 when config points at the site plane", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-plane");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8787" }));
    const seen: string[] = [];
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          seen.push(String(input));
          if (String(input).includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
          if (String(input).includes(":8794/health")) return new Response(JSON.stringify({ ok: true }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      expect(seen.some((u) => u.includes(":8788/health"))).toBe(true);
      expect(checks.find((c) => c.name === "planes")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "planes")?.detail).toContain("8787");
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
