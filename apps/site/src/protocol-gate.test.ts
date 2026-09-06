import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDEN_PROTOCOL_VERSION, PROTOCOL_HEADER } from "@eden/ir";

/**
 * The /v1/* protocol gate: a mismatched wire version is refused with 426 and
 * an explanation; matching and absent versions proceed to normal handling.
 *
 * Deliberately does not pin EDEN_DEV: unauthenticated /v1/setup is 200 on a
 * laptop and 401 on a deployment. Cache-bust + private EDEN_DB so shuffle
 * cannot share another suite's memoized (and later deleted) db handle.
 */
describe("/v1 protocol gate", () => {
  const base = "http://127.0.0.1:8787/v1/tools";
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let handleFetch: (req: Request) => Promise<Response>;
  const SERVER_MOD = `./server?bust=protocol-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_DB", "EDEN_SKIP_SEED"]) {
      saved[k] = process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-protocol-"));
    process.env.EDEN_DB = join(dir, "p.db");
    process.env.EDEN_SKIP_SEED = "1";
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    ({ handleFetch } = await import(SERVER_MOD));
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("health reports the protocol version", async () => {
    const res = await handleFetch(new Request("http://127.0.0.1:8787/health"));
    const j = (await res.json()) as { protocol?: number; service?: string; wrap?: boolean };
    expect(j.protocol).toBe(EDEN_PROTOCOL_VERSION);
    expect(res.headers.get(PROTOCOL_HEADER)).toBe(String(EDEN_PROTOCOL_VERSION));
    expect(j.service).toBe("eden-wrap");
    expect(j.wrap).toBe(true);
  });

  test("mismatched client version is refused with 426 and both numbers named — before auth even runs", async () => {
    const res = await handleFetch(
      new Request(base, { headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION + 99) } }),
    );
    expect(res.status).toBe(426);
    const j = (await res.json()) as { error?: string };
    expect(j.error).toContain(`client speaks ${EDEN_PROTOCOL_VERSION + 99}`);
    expect(j.error).toContain(`server speaks ${EDEN_PROTOCOL_VERSION}`);
  });

  test("matching and absent versions proceed to normal handling (never 426)", async () => {
    // /v1/setup answers from env alone — no database, no auth — so the ONLY
    // thing this proves is that the gate passed the request through. Its
    // status is env-dependent (200 on a laptop, 401 on a deployment).
    const matched = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/setup", {
        method: "POST",
        headers: { host: "127.0.0.1:8787", [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) },
        body: "{}",
      }),
    );
    expect(matched.status).not.toBe(426);
    // Legacy client: no header at all — must keep working.
    const legacy = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/setup", { method: "POST", headers: { host: "127.0.0.1:8787" }, body: "{}" }),
    );
    expect(legacy.status).not.toBe(426);
  });
});
