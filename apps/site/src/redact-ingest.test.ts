import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "@eden/core";

/**
 * P1: the plane itself redacts credential-shaped values at the ingest
 * boundary. Clients vary (hooks redact locally, SDKs may not) — persistence
 * is where the guarantee must live.
 *
 * Authenticates with a REAL seeded key rather than the dev fallback, so this
 * suite does not depend on (or race with) EDEN_DEV env mutations elsewhere.
 * Reads back what landed on disk via a direct SQLite connection.
 *
 * Private server+db: a static `./server` import shared the memoized handle
 * with every other site suite; under --randomize that handle often pointed
 * at a different (or deleted) EDEN_DB than `dbFile` below.
 */
const DB_FILE = join(tmpdir(), `eden-redact-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const SERVER_MOD = `./server?bust=redact-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("server-side redaction at ingest", () => {
  const saved: Record<string, string | undefined> = {};
  let key = "";
  let handleFetch: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED", "EDEN_DEV", "EDEN_DB"]) saved[k] = process.env[k];
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    delete process.env.EDEN_DEV;
    process.env.EDEN_DB = DB_FILE;

    ({ handleFetch } = await import(SERVER_MOD));

    // Seed a workspace + key through the same public door users use.
    const res = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/signup", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          "content-type": "application/json",
          "x-real-ip": `10.${Math.floor(Math.random() * 255)}.0.1`,
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    key = ((await res.json()) as { api_key: string }).api_key;
    expect(key).toBeString();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("secrets are persisted redacted; ordinary values survive", async () => {
    const SECRET = "sk-live-abcdef123456";
    const BEARER = "Bearer abcdefgh12345678";
    const events = [
      {
        event_id: "e1",
        seq: 0,
        name: "lookupTicket",
        args: { id: "T-1", api_key: SECRET },
        result: { status: 200, headers: { authorization: BEARER } },
        ok: true,
      },
    ] satisfies ToolEvent[];
    const res = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/ingest", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ run_id: "redact-run-1", stretch_end: false, events }),
      }),
    );
    expect(res.status).toBe(202);

    // Read back what actually landed on disk via a second connection.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(DB_FILE) as unknown as {
      query(s: string): { all(): Array<{ args: string | null; command: string | null }> };
      close(): void;
    };
    try {
      const rows = raw.query(`SELECT args, command FROM tool_event`).all();
      const everything = JSON.stringify(rows);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain("abcdefgh12345678");
      expect(everything).toContain("T-1"); // ordinary values survive
      expect(everything).toMatch(/REDACTED/i);
    } finally {
      raw.close();
    }
  });
});
