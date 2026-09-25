import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as doctorMod from "./doctor";
import { applyCodexToml, geminiHookConfig, hookCommand, opencodePluginSource, preHookCommand, codexHooksJson } from "./setup";
import {
  autoApproveCheck,
  collectDoctor,
  doctor,
  doctorHelp,
  doctorPayload,
  formatDoctor,
  FUNNEL_STAGES,
  funnelCheck,
  funnelSnapshot,
  hookdOrphanDetail,
  liveToolsDetail,
  liveToolsDoctorLine,
  netAllowCheck,
  probeJson,
  parseNetAllow,
  PROBE_MS,
  recordState,
  surfaceCheck,
  surfaceModeOf,
  treeCheck,
  memoryHooksCheck,
  MEMORY_HOOK_EVENTS,
} from "./doctor";
import { renderTreeLetter } from "@eden/measure";

function funnelOf(checks: Awaited<ReturnType<typeof collectDoctor>>) {
  return FUNNEL_STAGES.map((name) => checks.find((c) => c.name === name));
}

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
          if (url.includes("/v1/wrap")) return new Response(JSON.stringify({ action: "original" }), { status: 200 });
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "config")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "agent-http")?.ok).toBe(true);
      expect(formatDoctor(checks)).toContain("ok  wrap:");
      expect(checks.find((c) => c.name === "hookd")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "live-tools")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "live-tools")?.detail).toBe("0 programs");
      expect(checks.find((c) => c.name === "mine")?.detail).toMatch(/^0 · /);
      expect(checks.find((c) => c.name === "mine")?.count).toBe(0);
      expect(checks.find((c) => c.name === "mine")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "lanes")?.detail).toMatch(/wrap/);
      expect(checks.find((c) => c.name === "knock")?.name).toBe("knock");
      expect(checks.find((c) => c.name === "knock")?.count).toBe(0);
      expect(checks.find((c) => c.name === "knock")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "serving")?.detail).toMatch(/^0 · /);
      expect(checks.find((c) => c.name === "serving")?.detail).toMatch(/first serving after Approve/);
      expect(checks.find((c) => c.name === "serving")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "approve")?.detail).toMatch(/eden approve/);
      expect(checks.find((c) => c.name === "approve")?.count).toBe(0);
      expect(checks.find((c) => c.name === "approve")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "install")?.name).toBe("install");
      expect(checks.find((c) => c.name === "record")?.name).toBe("record");
      expect(checks.find((c) => c.name === "record")?.count).toBe(2);
      expect(checks.find((c) => c.name === "record")?.ok).toBe(true);
      expect(formatDoctor(checks)).toContain("ok  wrap:");
      expect(checks.find((c) => c.name === "net-allow")?.ok).toBe(true);
      expect(formatDoctor(checks)).toMatch(/ok {2}net-allow: EDEN_NET_ALLOW /);
      expect(formatDoctor(checks)).toMatch(/!! {2}mine: 0 ·/);
      expect(formatDoctor(checks)).toMatch(/!! {2}approve: 0 ·/);
      expect(formatDoctor(checks)).toMatch(/!! {2}serving: 0 ·/);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("live-tools names wrap serving 0 when the disk cache is a demo canary", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-canary-disk");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ name: "lookupTicket", rollout: "canary" }]));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 19, live: 0 }));
          if (url.includes("/v1/wrap")) return new Response(JSON.stringify({ action: "original" }), { status: 200 });
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "live-tools")?.detail).toBe("1 programs · 1 Canary on disk · wrap serving 0");
      expect(checks.find((c) => c.name === "agent-http")?.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wrap health up but POST /v1/wrap 404 is named restart", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-stale-wrap");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 1, live: 0 }));
          return new Response("Not found", { status: 404 });
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "agent-http")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "agent-http")?.detail).toContain("restart eden wrap");
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

  test("wrap down does not tell you to wrap more runs", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-down");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async () => {
          throw new Error("down");
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "mine")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "mine")?.detail).toMatch(/unknown · wrap is down/);
      expect(checks.find((c) => c.name === "serving")?.detail).toMatch(/unknown · wrap is down/);
      expect(checks.find((c) => c.name === "approve")?.detail).toMatch(/unknown · wrap is down/);
      expect(formatDoctor(checks)).not.toMatch(/wrap more runs/);
      expect(checks.filter((c) => c.name === "config" || c.name === "wrap").every((c) => c.ok)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("live orphan names /health pid, stale pid file, and eden hookd --stop", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-orphan");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    const { writeHookdPid, clearHookdPid } = await import("./hookd");
    writeHookdPid(99999999);
    try {
      expect(hookdOrphanDetail(4242, 99999999)).toBe(
        "orphan · /health pid 4242 · pid file 99999999 · eden hookd --stop",
      );
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          if (String(input).includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
          if (String(input).includes(":8794/health")) {
            return new Response(JSON.stringify({ ok: true, service: "eden-hookd", pid: 4242 }));
          }
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      const row = checks.find((c) => c.name === "hookd");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toBe("orphan · /health pid 4242 · pid file 99999999 · eden hookd --stop");
      expect(row?.detail).toContain("eden hookd --stop");
      expect(formatDoctor(checks)).toContain("!!  hookd: orphan");
    } finally {
      clearHookdPid();
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("owned hookd matching /health pid stays up · record", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-owned");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    const { writeHookdPid, clearHookdPid } = await import("./hookd");
    writeHookdPid(process.pid);
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          if (String(input).includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
          if (String(input).includes(":8794/health")) {
            return new Response(JSON.stringify({ ok: true, service: "eden-hookd", pid: process.pid }));
          }
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "hookd")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "hookd")?.detail).toBe("up · record");
      expect(formatDoctor(checks)).toContain("ok  hookd: up · record");
    } finally {
      clearHookdPid();
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stale hookd pid is named with a start sentence", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-stale");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    const { writeHookdPid, clearHookdPid } = await import("./hookd");
    writeHookdPid(99999999);
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          if (String(input).includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
          throw new Error("hookd down");
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "hookd")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "hookd")?.detail).toMatch(/stale pid 99999999 · start with eden hookd/);
    } finally {
      clearHookdPid();
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("live-tools names Canary vs Live in the same words as Home", () => {
    expect(liveToolsDetail([])).toBe("0 programs");
    expect(liveToolsDetail([{ name: "old" }])).toBe("1 programs");
    expect(
      liveToolsDetail([
        { name: "a", rollout: "canary" },
        { name: "b", rollout: "canary" },
        { name: "c" },
      ]),
    ).toBe("3 programs · 2 Canary · 1 Live");
    expect(liveToolsDetail([{ name: "a", rollout: "canary" }, { name: "b", rollout: "canary" }])).toBe(
      "2 programs · 2 Canary",
    );
    expect(liveToolsDoctorLine([{ name: "a", rollout: "canary" }], 0)).toBe(
      "1 programs · 1 Canary on disk · wrap serving 0",
    );
    expect(liveToolsDoctorLine([{ name: "a", rollout: "canary" }], 1)).toBe("1 programs · 1 Canary");
  });

  test("funnel stages are named in install → record → mine → knock → approve → serving with counts", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-funnel");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 4, live: 0 }));
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
          if (url.includes("/v1/inbox")) {
            return new Response(
              JSON.stringify({
                candidates: [
                  { verdict: "PASS" },
                  { verdict: "FAIL" },
                  { verdict: "pending", refusal: { reason: "uncovered-envelope" } },
                ],
                live: [{ stats: { n: 3 } }, { stats: { n: 0 } }],
              }),
            );
          }
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      const names = funnelOf(checks).map((c) => c?.name);
      expect(names).toEqual([...FUNNEL_STAGES]);
      expect(checks.find((c) => c.name === "record")?.count).toBe(4);
      expect(checks.find((c) => c.name === "mine")?.count).toBe(3);
      expect(checks.find((c) => c.name === "approve")?.count).toBe(1);
      expect(checks.find((c) => c.name === "serving")?.count).toBe(1);
      expect(checks.find((c) => c.name === "knock")?.count).toBe(0);
      expect(typeof checks.find((c) => c.name === "install")?.count).toBe("number");
      for (const stage of FUNNEL_STAGES) {
        const c = checks.find((x) => x.name === stage);
        expect(c?.detail).toMatch(/^\d+ · \S/);
        expect(typeof c?.count).toBe("number");
      }
      const printed = formatDoctor(checks);
      const idx = FUNNEL_STAGES.map((n) => printed.indexOf(`  ${n}:`));
      for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
      expect(checks.find((c) => c.name === "record")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "mine")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "approve")?.ok).toBe(true);
      expect(checks.find((c) => c.name === "serving")?.ok).toBe(true);
      expect(printed).toMatch(/ok {2}mine: 3 · /);
      expect(printed).toMatch(/ok {2}approve: 1 · eden approve/);
      expect(printed).toMatch(/ok {2}serving: 1 · live with receipts/);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wrap down funnel: install/record/knock stay counted; mine/approve/serving stay unknown", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-funnel-down");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    writeFileSync(join(home, "knock.json"), JSON.stringify({ tool_id: "desk" }));
    try {
      const checks = await collectDoctor({
        fetch: (async () => {
          throw new Error("down");
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "install")?.detail).toMatch(/^\d+ · /);
      expect(checks.find((c) => c.name === "record")?.count).toBe(0);
      expect(checks.find((c) => c.name === "record")?.detail).toMatch(/^0 · start with eden hookd/);
      expect(checks.find((c) => c.name === "knock")?.count).toBe(1);
      expect(checks.find((c) => c.name === "knock")?.detail).toMatch(/^1 · eden open or eden approve/);
      expect(checks.find((c) => c.name === "mine")?.count).toBeNull();
      expect(checks.find((c) => c.name === "approve")?.count).toBeNull();
      expect(checks.find((c) => c.name === "serving")?.count).toBeNull();
      expect(checks.find((c) => c.name === "mine")?.detail).toBe("unknown · wrap is down");
      expect(formatDoctor(checks)).not.toMatch(/wrap more runs/);
      const snap = funnelSnapshot(checks);
      expect(snap.map((s) => s.name)).toEqual([...FUNNEL_STAGES]);
      expect(snap.find((s) => s.name === "mine")?.count).toBeNull();
      expect(Object.keys(snap[0] ?? {}).sort()).toEqual(["count", "name"]);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wrap-up empty mine/approve/serving/record are !! with integer 0, not a healthy ok", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-zeros");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
          if (url.includes("/v1/inbox")) return new Response(JSON.stringify({ candidates: [], live: [] }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      for (const stage of FUNNEL_STAGES) {
        expect(typeof checks.find((c) => c.name === stage)?.count).toBe("number");
      }
      expect(checks.find((c) => c.name === "record")?.count).toBe(0);
      expect(checks.find((c) => c.name === "record")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "mine")?.count).toBe(0);
      expect(checks.find((c) => c.name === "mine")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "approve")?.count).toBe(0);
      expect(checks.find((c) => c.name === "approve")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "serving")?.count).toBe(0);
      expect(checks.find((c) => c.name === "serving")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "knock")?.count).toBe(0);
      expect(checks.find((c) => c.name === "knock")?.ok).toBe(true);
      const printed = formatDoctor(checks);
      expect(printed).toMatch(/!! {2}record: 0 · wrap more runs/);
      expect(printed).toMatch(/!! {2}mine: 0 · wrap more runs/);
      expect(printed).toMatch(/!! {2}approve: 0 ·/);
      expect(printed).toMatch(/!! {2}serving: 0 ·/);
      expect(printed).toMatch(/ok {2}knock: 0 · none waiting/);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("inbox 401 without Authorization, 200 with Bearer from config; mine from authenticated body", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-inbox-auth");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_gated", base_url: "http://127.0.0.1:8788" }));

    function authOf(init?: RequestInit): string | undefined {
      const h = init?.headers;
      if (!h) return undefined;
      if (h instanceof Headers) return h.get("Authorization") ?? h.get("authorization") ?? undefined;
      if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === "authorization")?.[1];
      const rec = h as Record<string, string>;
      return rec.Authorization ?? rec.authorization;
    }

    try {
      const seen: Array<{ url: string; auth?: string }> = [];
      const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const auth = authOf(init);
        seen.push({ url, auth });
        if (url.includes(":8788/health")) {
          return new Response(JSON.stringify({ ok: true, traces: 5, live: 0, candidates: 9 }));
        }
        if (url.includes("/v1/inbox")) {
          if (auth !== "Bearer eden_gated") {
            return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
          }
          return new Response(
            JSON.stringify({
              candidates: [{ verdict: "PASS" }, { verdict: "FAIL" }],
              live: [],
            }),
          );
        }
        if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
        return new Response("no", { status: 404 });
      }) as typeof fetch;

      const unauth = await probeJson("http://127.0.0.1:8788/v1/inbox", gatedFetch);
      expect(unauth?.ok).toBe(false);
      expect(unauth?.status).toBe(401);
      const authed = await probeJson("http://127.0.0.1:8788/v1/inbox", gatedFetch, PROBE_MS, {
        headers: { Authorization: "Bearer eden_gated" },
      });
      expect(authed?.ok).toBe(true);
      expect(authed?.status).toBe(200);
      expect((authed?.body as { candidates?: unknown[] })?.candidates).toHaveLength(2);

      seen.length = 0;
      const checks = await collectDoctor({ fetch: gatedFetch });
      const inboxCalls = seen.filter((s) => s.url.includes("/v1/inbox"));
      expect(inboxCalls.length).toBeGreaterThan(0);
      expect(inboxCalls.every((s) => s.auth === "Bearer eden_gated")).toBe(true);
      expect(checks.find((c) => c.name === "mine")?.count).toBe(2);
      expect(checks.find((c) => c.name === "mine")?.ok).toBe(true);
      expect(formatDoctor(checks)).toMatch(/ok {2}mine: 2 · /);
      expect(checks.find((c) => c.name === "approve")?.count).toBe(1);

      const fallback = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) {
            return new Response(JSON.stringify({ ok: true, traces: 5, live: 0, candidates: 4 }));
          }
          if (url.includes("/v1/inbox")) {
            return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
          }
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      expect(fallback.find((c) => c.name === "mine")?.count).toBe(4);
      expect(fallback.find((c) => c.name === "mine")?.ok).toBe(true);
      expect(formatDoctor(fallback)).toMatch(/ok {2}mine: 4 · /);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("hookd up and wrap down does not invent record=1", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-fake-record");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          if (String(input).includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
          throw new Error("wrap down");
        }) as typeof fetch,
      });
      expect(checks.find((c) => c.name === "hookd")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "record")?.count).not.toBe(1);
      expect(checks.find((c) => c.name === "record")?.detail).not.toMatch(/^1 /);
      const n = checks.find((c) => c.name === "record")?.count;
      expect(n === 0 || n === null).toBe(true);
      expect(checks.find((c) => c.name === "record")?.detail).toBe("unknown · wrap is down");
      expect(checks.find((c) => c.name === "mine")?.detail).toBe("unknown · wrap is down");
      expect(checks.find((c) => c.name === "approve")?.detail).toBe("unknown · wrap is down");
      expect(checks.find((c) => c.name === "serving")?.detail).toBe("unknown · wrap is down");
      expect(formatDoctor(checks)).not.toMatch(/wrap more runs/);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recordState never invents 1 when traces are unknown", () => {
    expect(recordState(undefined, false, true)).toEqual({ count: null, fix: "unknown · wrap is down" });
    expect(recordState(undefined, false, false)).toEqual({ count: 0, fix: "start with eden hookd" });
    expect(recordState(0, true, true).count).toBe(0);
    expect(recordState(4, true, false).count).toBe(4);
    expect(recordState(undefined, true, true).count).toBe(0);
  });

  test("empty stages print 0, never blank; --json is names and counts only on funnel", () => {
    const row = funnelCheck("serving", true, 0, "first serving after Approve");
    expect(row.detail).toBe("0 · first serving after Approve");
    expect(row.count).toBe(0);
    const unknown = funnelCheck("mine", false, null, "wrap more runs");
    expect(unknown.detail).toBe("unknown · wrap is down");
    expect(unknown.count).toBeNull();
    const payload = doctorPayload([
      { name: "config", ok: true, detail: "http://127.0.0.1:8788 · key abc" },
      funnelCheck("install", true, 1, "hooks installed"),
      funnelCheck("record", true, 2, "recording"),
      funnelCheck("mine", true, 0, "wrap more runs"),
      funnelCheck("knock", true, 0, "none waiting"),
      funnelCheck("approve", true, 0, "eden approve after a PASS card"),
      funnelCheck("serving", true, 0, "first serving after Approve"),
    ]);
    expect(payload.funnel).toEqual([
      { name: "install", count: 1 },
      { name: "record", count: 2 },
      { name: "mine", count: 0 },
      { name: "knock", count: 0 },
      { name: "approve", count: 0 },
      { name: "serving", count: 0 },
    ]);
    expect(JSON.stringify(payload.funnel)).not.toMatch(/key |tool_|args/);
  });

  test("parseNetAllow trims, drops empties, keeps hostile names as data", () => {
    expect(parseNetAllow(undefined)).toEqual([]);
    expect(parseNetAllow("")).toEqual([]);
    expect(parseNetAllow("  ")).toEqual([]);
    expect(parseNetAllow(",,")).toEqual([]);
    expect(parseNetAllow("curl")).toEqual(["curl"]);
    expect(parseNetAllow("curl, wget")).toEqual(["curl", "wget"]);
    expect(parseNetAllow(" curl, , wget ")).toEqual(["curl", "wget"]);
    expect(parseNetAllow("__proto__, constructor")).toEqual(["__proto__", "constructor"]);
  });

  test("net-allow empty is an honest refuse sentence, not allow-all", () => {
    for (const raw of [undefined, "", "  ", ",,"] as const) {
      const c = netAllowCheck(raw);
      expect(c.name).toBe("net-allow");
      expect(c.ok).toBe(true);
      expect(c.count).toBe(0);
      expect(c.detail).toBe("EDEN_NET_ALLOW empty · piped network binaries stay refused");
      expect(c.detail.toLowerCase()).not.toMatch(/all hosts|allow all|not configured/);
    }
  });

  test("net-allow lists trimmed comma-separated names", () => {
    expect(netAllowCheck("curl")).toEqual({
      name: "net-allow",
      ok: true,
      count: 1,
      detail: "EDEN_NET_ALLOW curl",
    });
    expect(netAllowCheck("curl, wget")).toEqual({
      name: "net-allow",
      ok: true,
      count: 2,
      detail: "EDEN_NET_ALLOW curl, wget",
    });
    expect(netAllowCheck(" curl, , wget ")).toEqual({
      name: "net-allow",
      ok: true,
      count: 2,
      detail: "EDEN_NET_ALLOW curl, wget",
    });
  });

  test("net-allow keeps hostile __proto__ as a listed name", () => {
    const c = netAllowCheck("__proto__, constructor");
    expect(c.count).toBe(2);
    expect(c.detail).toBe("EDEN_NET_ALLOW __proto__, constructor");
    expect(JSON.stringify(c)).toContain("__proto__");
  });

  test("formatDoctor prints net-allow in health; --json includes count, not funnel", () => {
    const empty = netAllowCheck("");
    const printed = formatDoctor([
      { name: "config", ok: true, detail: "http://127.0.0.1:8788 · key abc" },
      empty,
      funnelCheck("install", true, 1, "hooks installed"),
      funnelCheck("record", true, 0, "wrap more runs"),
      funnelCheck("mine", true, 0, "wrap more runs"),
      funnelCheck("knock", true, 0, "none waiting"),
      funnelCheck("approve", true, 0, "eden approve after a PASS card"),
      funnelCheck("serving", true, 0, "first serving after Approve"),
    ]);
    expect(printed).toContain("ok  net-allow: EDEN_NET_ALLOW empty · piped network binaries stay refused");
    expect(printed.indexOf("net-allow:")).toBeLessThan(printed.indexOf("  install:"));
    const payload = doctorPayload([
      { name: "config", ok: true, detail: "x" },
      empty,
      funnelCheck("install", true, 1, "hooks installed"),
      funnelCheck("record", true, 2, "recording"),
      funnelCheck("mine", true, 0, "wrap more runs"),
      funnelCheck("knock", true, 0, "none waiting"),
      funnelCheck("approve", true, 0, "eden approve after a PASS card"),
      funnelCheck("serving", true, 0, "first serving after Approve"),
    ]);
    expect(payload.checks.find((c) => c.name === "net-allow")).toEqual(empty);
    expect(payload.funnel.map((s) => s.name)).toEqual([...FUNNEL_STAGES]);
    expect(JSON.stringify(payload, null, 2)).toContain('"name": "net-allow"');
    expect(JSON.stringify(payload.funnel)).not.toContain("net-allow");
  });

  test("collectDoctor empty EDEN_NET_ALLOW is ok with count 0 and does not sit in funnel", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-net-empty");
    mkdirSync(home, { recursive: true });
    const prevHome = process.env.EDEN_HOME;
    const prevAllow = process.env.EDEN_NET_ALLOW;
    process.env.EDEN_HOME = home;
    delete process.env.EDEN_NET_ALLOW;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 2, live: 1 }));
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true, service: "eden-hookd" }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      const row = checks.find((c) => c.name === "net-allow");
      expect(row?.ok).toBe(true);
      expect(row?.count).toBe(0);
      expect(row?.detail).toBe("EDEN_NET_ALLOW empty · piped network binaries stay refused");
      const printed = formatDoctor(checks);
      expect(printed).toContain("ok  net-allow: EDEN_NET_ALLOW empty · piped network binaries stay refused");
      expect(printed.toLowerCase()).not.toMatch(/all hosts|allow all/);
      expect(FUNNEL_STAGES).not.toContain("net-allow");
      expect(funnelSnapshot(checks).some((s) => (s as { name: string }).name === "net-allow")).toBe(false);
      const payload = doctorPayload(checks);
      expect(payload.checks.find((c) => c.name === "net-allow")?.count).toBe(0);
      expect(checks.filter((c) => c.name === "config" || c.name === "wrap").every((c) => c.ok)).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevAllow === undefined) delete process.env.EDEN_NET_ALLOW;
      else process.env.EDEN_NET_ALLOW = prevAllow;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("collectDoctor names EDEN_NET_ALLOW=curl and curl, wget", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-net-curl");
    mkdirSync(home, { recursive: true });
    const prevHome = process.env.EDEN_HOME;
    const prevAllow = process.env.EDEN_NET_ALLOW;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
      if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true }));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    try {
      process.env.EDEN_NET_ALLOW = "curl";
      const one = await collectDoctor({ fetch: fakeFetch });
      expect(one.find((c) => c.name === "net-allow")).toEqual({
        name: "net-allow",
        ok: true,
        count: 1,
        detail: "EDEN_NET_ALLOW curl",
      });
      expect(formatDoctor(one)).toContain("ok  net-allow: EDEN_NET_ALLOW curl");
      expect(doctorPayload(one).checks.find((c) => c.name === "net-allow")?.count).toBe(1);

      process.env.EDEN_NET_ALLOW = "curl, wget";
      const two = await collectDoctor({ fetch: fakeFetch });
      expect(two.find((c) => c.name === "net-allow")).toEqual({
        name: "net-allow",
        ok: true,
        count: 2,
        detail: "EDEN_NET_ALLOW curl, wget",
      });
      expect(formatDoctor(two)).toContain("ok  net-allow: EDEN_NET_ALLOW curl, wget");
    } finally {
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevAllow === undefined) delete process.env.EDEN_NET_ALLOW;
      else process.env.EDEN_NET_ALLOW = prevAllow;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("surface check names jit-soak PASS pin; empty is jit, unknown is all", () => {
    expect(surfaceModeOf(undefined)).toBe("jit");
    expect(surfaceModeOf("")).toBe("jit");
    expect(surfaceModeOf("JIT")).toBe("jit");
    expect(surfaceModeOf("shadow")).toBe("jit-shadow");
    expect(surfaceModeOf("bogus")).toBe("all");
    expect(surfaceCheck(undefined).detail).toBe(
      "EDEN_SURFACE jit · default after soak PASS precision=1.000 n=38",
    );
    expect(surfaceCheck("all").ok).toBe(true);
    expect(surfaceCheck("all").detail).toMatch(/opt-out · default jit/);
    expect(surfaceCheck("jit").name).toBe("surface");
  });

  test("tree check is health, not funnel; letter is closed and Wave 21 closed", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-tree");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
          if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true }));
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      });
      const tree = checks.find((c) => c.name === "tree");
      expect(tree?.ok).toBe(true);
      expect(tree?.count).toBe(0);
      expect(tree?.detail).toMatch(/Wave 16–20 0 open/);
      expect(tree?.detail).toMatch(/Wave 21 closed/);
      expect(tree?.detail).toMatch(/Wave 22\.2 shipped/);
      expect(FUNNEL_STAGES).not.toContain("tree");
      expect(funnelSnapshot(checks).some((s) => (s as { name: string }).name === "tree")).toBe(false);
      const printed = formatDoctor(checks);
      expect(printed).toContain("ok  tree:");
      expect(printed.indexOf("tree:")).toBeLessThan(printed.indexOf("  install:"));
      expect(treeCheck().ok).toBe(true);
      expect(renderTreeLetter()).toMatch(/^Tree closed — Wave 16–20/);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("approve-gate names EDEN_AUTO_APPROVE off; =1 is !! and not a funnel stage", async () => {
    expect(autoApproveCheck(undefined).ok).toBe(true);
    expect(autoApproveCheck("1").ok).toBe(false);
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-approve");
    mkdirSync(home, { recursive: true });
    const prevHome = process.env.EDEN_HOME;
    const prev = process.env.EDEN_AUTO_APPROVE;
    process.env.EDEN_HOME = home;
    delete process.env.EDEN_AUTO_APPROVE;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(":8788/health")) return new Response(JSON.stringify({ ok: true, traces: 0, live: 0 }));
      if (url.includes(":8794/health")) return new Response(JSON.stringify({ ok: true }));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    try {
      const off = await collectDoctor({ fetch: fakeFetch });
      expect(off.find((c) => c.name === "approve-gate")).toEqual({
        name: "approve-gate",
        ok: true,
        detail: "human Approve required · EDEN_AUTO_APPROVE off",
      });
      expect(formatDoctor(off)).toContain("ok  approve-gate: human Approve required · EDEN_AUTO_APPROVE off");
      expect(FUNNEL_STAGES).not.toContain("approve-gate");
      process.env.EDEN_AUTO_APPROVE = "1";
      const on = await collectDoctor({ fetch: fakeFetch });
      expect(on.find((c) => c.name === "approve-gate")?.ok).toBe(false);
      expect(formatDoctor(on)).toContain("!!  approve-gate: EDEN_AUTO_APPROVE on · human gate bypassed");
    } finally {
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prev === undefined) delete process.env.EDEN_AUTO_APPROVE;
      else process.env.EDEN_AUTO_APPROVE = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("doctor --tree prints the letter without needing wrap; --help names NET_ALLOW and orphan", async () => {
    const logs: string[] = [];
    const log = console.log;
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ""));
    };
    try {
      expect(await doctor(["--help"])).toBe(0);
      expect(logs.join("\n")).toMatch(/eden doctor/);
      expect(logs.join("\n")).toMatch(/EDEN_AUTO_APPROVE/);
      expect(doctorHelp()).toMatch(/Wave 16–20 leftover letter/);
      logs.length = 0;
      expect(await doctor(["--tree"])).toBe(0);
      expect(logs.join("\n")).toBe(renderTreeLetter());
      logs.length = 0;
      expect(await doctor(["--tree", "--json"])).toBe(0);
      const snap = JSON.parse(logs.join("\n")) as { closed: boolean; open16_20: number; customers: number };
      expect(snap.closed).toBe(true);
      expect(snap.open16_20).toBe(0);
      expect(snap.customers).toBe(0);
    } finally {
      console.log = log;
    }
  });

  test("a hung wrap fetch still finishes; wrap is named down", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-hang");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    const hung = () => new Promise<Response>(() => {}) as Promise<Response>;
    const t0 = Date.now();
    try {
      const checks = await collectDoctor({ fetch: hung as typeof fetch });
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(checks.find((c) => c.name === "wrap")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "wrap")?.detail).toMatch(/down · control wrap/);
      expect(checks.find((c) => c.name === "hookd")?.ok).toBe(false);
      expect(checks.find((c) => c.name === "tree")?.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("probeJson returns null on a never-resolving fetch", async () => {
    const t0 = Date.now();
    const out = await probeJson("http://127.0.0.1:9/health", () => new Promise(() => {}) as Promise<Response>, 50);
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("M13.3 memory hooks doctor", () => {
  const edenHook = [{ hooks: [{ type: "command", command: "bun '/abs/cli.ts' hook || echo '{}'" }] }];

  test("memoryHooksCheck lists installed events; half-wired is ok:false and names missing", () => {
    expect(typeof memoryHooksCheck).toBe("function");

    const plugin = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../plugins/eden-memory/hooks/hooks.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    const full = memoryHooksCheck({ hooks: plugin.hooks });
    expect(full.name).toBe("memory");
    expect(full.ok).toBe(true);
    expect(full.detail).toContain("UserPromptSubmit");
    expect(full.detail).toContain("Stop");
    expect(full.detail).toContain("PostToolUse");
    expect(full.detail).toContain("SubagentStop");
    expect(full.detail).toMatch(/EDEN_MEMORY /);
    expect(JSON.stringify(full)).not.toContain("/forget");
    expect(formatDoctor([full])).not.toContain("/forget");

    const half = memoryHooksCheck({ hooks: { UserPromptSubmit: edenHook } });
    expect(half.ok).toBe(false);
    expect(half.name).toBe("memory");
    expect(half.detail).toContain("missing");
    for (const ev of MEMORY_HOOK_EVENTS) {
      if (ev === "UserPromptSubmit") continue;
      expect(half.detail).toContain(ev);
    }
    expect(JSON.stringify(half)).not.toContain("/forget");

    const empty = memoryHooksCheck({});
    expect(empty.ok).toBe(false);
    expect(empty.detail).toContain("none");
    expect(empty.detail).toContain("UserPromptSubmit");

    const onlySteer = memoryHooksCheck({ hooks: { PreToolUse: edenHook } });
    expect(onlySteer.ok).toBe(false);
    expect(onlySteer.detail).toContain("none");
  });

  test("doctor output has no /forget", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-doctor-m13-forget");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    try {
      const checks = await collectDoctor({
        fetch: (async () => new Response("no", { status: 404 })) as typeof fetch,
      });
      expect(formatDoctor(checks)).not.toContain("/forget");
      expect(JSON.stringify(checks)).not.toContain("/forget");
      expect(doctorHelp()).not.toContain("/forget");
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

type ExtraHostMemoryOpts = { homedir?: string };
type ExtraHostCheck = { name: string; ok: boolean; detail: string };

/** M14.2 — intended export: extra-host memory wiring (Codex / OpenCode / Gemini / Cursor). */
function extraHostMemoryCheck(opts?: ExtraHostMemoryOpts): ExtraHostCheck[] {
  const fn = (doctorMod as { extraHostMemoryCheck?: (o?: ExtraHostMemoryOpts) => unknown }).extraHostMemoryCheck;
  expect(typeof fn).toBe("function");
  let out: unknown;
  expect(() => {
    out = fn!(opts);
  }).not.toThrow();
  const rows = Array.isArray(out) ? out : out == null ? [] : [out];
  expect(rows.length).toBeGreaterThan(0);
  return rows.map((raw) => {
    const c = raw && typeof raw === "object" ? (raw as { name?: unknown; ok?: unknown; detail?: unknown }) : {};
    expect(typeof c.name).toBe("string");
    expect(typeof c.ok).toBe("boolean");
    expect(typeof c.detail).toBe("string");
    return { name: String(c.name), ok: Boolean(c.ok), detail: String(c.detail) };
  });
}

function extraHay(rows: ExtraHostCheck[]): string {
  return rows.map((c) => `${c.name}\t${c.ok}\t${c.detail}`).join("\n");
}

function namedHost(rows: ExtraHostCheck[], host: RegExp): ExtraHostCheck[] {
  return rows.filter((c) => host.test(`${c.name} ${c.detail}`));
}

describe("M14.2 extra-host memory doctor", () => {
  const hookCmd = hookCommand("/abs/cli.ts", 8794);
  const preCmd = preHookCommand(8794);

  test("missing ~/.codex ~/.config/opencode ~/.gemini is skip named; cursor not invented", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-skip-"));
    try {
      const rows = extraHostMemoryCheck({ homedir: home });
      const hay = extraHay(rows);

      const codex = namedHost(rows, /codex/i);
      expect(codex.length).toBeGreaterThan(0);
      expect(codex.some((c) => /skip/i.test(c.detail))).toBe(true);

      const opencode = namedHost(rows, /opencode/i);
      expect(opencode.length).toBeGreaterThan(0);
      expect(opencode.some((c) => /skip/i.test(c.detail))).toBe(true);

      const gemini = namedHost(rows, /gemini/i);
      expect(gemini.length).toBeGreaterThan(0);
      expect(gemini.some((c) => /skip/i.test(c.detail))).toBe(true);

      expect(hay).toMatch(/cursor/i);
      expect(hay).toMatch(/skip|not invented|not-invented/i);
      expect(namedHost(rows, /cursor/i).every((c) => /skip|not invented|not-invented/i.test(c.detail))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("codex home without PostToolUse is half-wired ok:false; live hooks.json does not crash", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-codex-"));
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
      const half = extraHostMemoryCheck({ homedir: home });
      const halfCodex = namedHost(half, /codex/i);
      expect(halfCodex.some((c) => c.ok === false)).toBe(true);
      expect(halfCodex.some((c) => /half-wired|PostToolUse|missing|post_tool/i.test(c.detail))).toBe(true);

      writeFileSync(
        join(home, ".codex", "hooks.json"),
        JSON.stringify(codexHooksJson(hookCmd, preCmd), null, 2),
      );
      writeFileSync(join(home, ".codex", "config.toml"), applyCodexToml("", hookCmd, preCmd));
      let wired: ExtraHostCheck[] = [];
      expect(() => {
        wired = extraHostMemoryCheck({ homedir: home });
      }).not.toThrow();
      const wiredCodex = namedHost(wired, /codex/i);
      expect(wiredCodex.length).toBeGreaterThan(0);
      expect(wiredCodex.every((c) => c.ok)).toBe(true);
      expect(wiredCodex.some((c) => /ok/i.test(c.detail))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stale [hooks.eden] post_tool is half-wired, not ok", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-codex-stale-"));
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "config.toml"),
        "[features]\ncodex_hooks = true\n\n[hooks.eden]\npost_tool = [\"sh\", \"-c\", \"echo hi\"]\n",
      );
      const rows = extraHostMemoryCheck({ homedir: home });
      const codex = namedHost(rows, /codex/i);
      expect(codex.some((c) => c.ok === false)).toBe(true);
      expect(codex.some((c) => /half-wired|stale|post_tool|PostToolUse/i.test(c.detail))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("OpenCode plugin missing vs present: skip/half-wired vs not a crash", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-oc-"));
    try {
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      const half = extraHostMemoryCheck({ homedir: home });
      const halfOc = namedHost(half, /opencode/i);
      expect(halfOc.some((c) => c.ok === false)).toBe(true);
      expect(halfOc.some((c) => /half-wired|missing|plugin/i.test(c.detail))).toBe(true);

      mkdirSync(join(home, ".config", "opencode", "plugin"), { recursive: true });
      writeFileSync(join(home, ".config", "opencode", "plugin", "eden-recorder.js"), opencodePluginSource("/abs/cli.ts"));
      let wired: ExtraHostCheck[] = [];
      expect(() => {
        wired = extraHostMemoryCheck({ homedir: home });
      }).not.toThrow();
      const wiredOc = namedHost(wired, /opencode/i);
      expect(wiredOc.length).toBeGreaterThan(0);
      expect(wiredOc.every((c) => c.ok || !/half-wired/i.test(c.detail))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Gemini home without AfterTool is half-wired; valid settings do not crash", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-gem-"));
    try {
      mkdirSync(join(home, ".gemini"), { recursive: true });
      writeFileSync(join(home, ".gemini", "settings.json"), "{}");
      const half = extraHostMemoryCheck({ homedir: home });
      const halfGem = namedHost(half, /gemini/i);
      expect(halfGem.some((c) => c.ok === false)).toBe(true);
      expect(halfGem.some((c) => /half-wired|missing|AfterTool/i.test(c.detail))).toBe(true);

      writeFileSync(
        join(home, ".gemini", "settings.json"),
        JSON.stringify(geminiHookConfig({}, preCmd, hookCmd), null, 2),
      );
      let wired: ExtraHostCheck[] = [];
      expect(() => {
        wired = extraHostMemoryCheck({ homedir: home });
      }).not.toThrow();
      const wiredGem = namedHost(wired, /gemini/i);
      expect(wiredGem.length).toBeGreaterThan(0);
      expect(wiredGem.every((c) => c.ok || !/half-wired/i.test(c.detail))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cursor still skip/not-invented even if ~/.cursor exists", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-cursor-"));
    try {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      writeFileSync(join(home, ".cursor", "hooks.json"), "{\"hooks\":{}}");
      const rows = extraHostMemoryCheck({ homedir: home });
      const cursor = namedHost(rows, /cursor/i);
      expect(cursor.length).toBeGreaterThan(0);
      expect(cursor.some((c) => /skip|not invented|not-invented/i.test(c.detail))).toBe(true);
      expect(extraHay(rows)).not.toMatch(/cursorHookConfig/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("torn Codex toml / OpenCode plugin / Gemini settings do not throw", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-m14-doc-torn-"));
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(home, ".config", "opencode", "plugin"), { recursive: true });
      mkdirSync(join(home, ".gemini"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "not [ toml {{{");
      writeFileSync(join(home, ".config", "opencode", "plugin", "eden-recorder.js"), "not js {{{");
      writeFileSync(join(home, ".gemini", "settings.json"), "{");
      expect(() => extraHostMemoryCheck({ homedir: home })).not.toThrow();
      const rows = extraHostMemoryCheck({ homedir: home });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((c) => typeof c.ok === "boolean")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("M46.3 doctor mentions import", () => {
  test("doctorHelp names eden memory import and invents no ghost API", () => {
    const help = doctorHelp();
    expect(help).toContain("eden memory import");
    expect(help).not.toContain("/import");
    expect(help).not.toContain("/forget");
    expect(help).not.toContain("memory_search");
  });

  test("memoryHooksCheck empty detail names eden memory import", () => {
    const empty = memoryHooksCheck({});
    expect(empty.detail).toContain("eden memory import");
    expect(empty.detail).toContain("EDEN_MEMORY");
    expect(empty.detail).not.toContain("/forget");
    for (const ev of MEMORY_HOOK_EVENTS) expect(empty.detail).toContain(ev);
  });
});
