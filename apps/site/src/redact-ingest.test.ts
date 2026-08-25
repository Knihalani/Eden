import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "@eden/core";
import { handleFetch } from "./server";

/**
 * P1: the plane itself redacts credential-shaped values at the ingest
 * boundary. Clients vary (hooks redact locally, SDKs may not) — persistence
 * is where the guarantee must live.
 *
 * Posts a run carrying secrets, then opens the SQLite file directly to read
 * back exactly what landed on disk.
 */
describe("server-side redaction at ingest", () => {
  const saved: Record<string, string | undefined> = {};
  let dbFile: string;

  beforeEach(() => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED"]) saved[k] = process.env[k];
    dbFile = join(tmpdir(), `eden-redact-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.EDEN_DB = dbFile;
    process.env.EDEN_DEV = "1"; // laptop dev fallback: ws_local auth
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Do NOT delete dbFile here: the site server memoizes its database
    // handle, and another suite's in-flight request would hit a deleted file
    // (disk I/O error). tmpdir() is cleaned by the OS; one small test DB is
    // an acceptable resident.
  });

  test("secrets are persisted redacted; ordinary values survive", async () => {
    const SECRET = "sk-live-abcdef123456";
    const BEARER = "Bearer abcdefgh12345678";
    const res = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:8787" },
        body: JSON.stringify({
          run_id: "redact-run-1",
          stretch_end: false,
          events: [
            {
              event_id: "e1",
              seq: 0,
              name: "lookupTicket",
              args: { id: "T-1", api_key: SECRET },
              result: { status: 200, headers: { authorization: BEARER } },
              ok: true,
            },
          ] satisfies ToolEvent[],
        }),
      }),
    );
    expect(res.status).toBe(202);

    // Read back what actually landed on disk via a second connection.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(dbFile, { readonly: true } as never) as unknown as {
      query(s: string): { all(): Array<{ args: string | null; command: string | null }> };
      close(): void;
    };
    try {
      const rows = raw.query(`SELECT args, command FROM tool_event`).all() as Array<{
        args: string | null;
        command: string | null;
      }>;
      const everything = JSON.stringify(rows);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain("abcdefgh12345678");
      expect(everything).toContain("T-1"); // ordinary values survive
      expect(everything).toMatch(/REDACTED/i);
    } finally {
      raw.close();
    }  });
});
