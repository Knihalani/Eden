import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeConfig } from "./home";
import { scheduleCli, scheduleHelp } from "./schedule";

describe("eden schedule", () => {
  let home: string;
  const prevHome = process.env.EDEN_HOME;

  beforeEach(() => {
    home = join(import.meta.dir, `../../.tmp-eden-schedule-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("help: schedule does not Approve; pause never fires", () => {
    expect(scheduleHelp()).toMatch(/does not Approve/);
    expect(scheduleHelp()).toMatch(/paused tool never fires/);
    expect(scheduleHelp()).toMatch(/eden schedule tick/);
  });

  test("wrap down prints a sentence and does not throw", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => {
      logs.push(String(m ?? ""));
    };
    try {
      const code = await scheduleCli(["desk", "--cron", "* * * * *"], {
        fetch: (async () => {
          throw new Error("down");
        }) as typeof fetch,
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/wrap is down/);
    } finally {
      console.log = orig;
    }
  });

  test("--cron POSTs; without --cron does not POST", async () => {
    let posted = 0;
    const code = await scheduleCli(["desk"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") posted++;
        return new Response(JSON.stringify({ schedule: { cron: "30 14 * * *" } }), { status: 200 });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(posted).toBe(0);

    const yes = await scheduleCli(["desk", "--cron", "30 14 * * *"], {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") posted++;
        return new Response(JSON.stringify({ ok: true, cron: "30 14 * * *" }), { status: 200 });
      }) as typeof fetch,
    });
    expect(yes).toBe(0);
    expect(posted).toBe(1);
  });
});
