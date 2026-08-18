import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "./home";
import { drain, lastOutboxKind, stretchEndForRun } from "./drain";

describe("drain outbox", () => {
  test("stretch_end only when Stop was last for that run", () => {
    const box = [
      JSON.stringify({ run_id: "a", kind: "turn_split", ts: 1 }),
      JSON.stringify({ run_id: "a", kind: "stretch_end", ts: 2 }),
      JSON.stringify({ run_id: "b", kind: "turn_split", ts: 3 }),
    ].join("\n");
    expect(lastOutboxKind(box, "a")).toBe("stretch_end");
    expect(stretchEndForRun(box, "a")).toBe(true);
    expect(stretchEndForRun(box, "b")).toBe(false);
    expect(stretchEndForRun(box, "missing")).toBe(false);
  });
});

describe("drain actually drains", () => {
  /**
   * These exercise the real drain() against a stub site, because the bugs were
   * all in its control flow rather than in the pure helpers above.
   */
  let home: string;
  let savedHome: string | undefined;
  let savedKey: string | undefined;
  let savedBase: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ingested: Array<{ run_id: string; stretch_end?: boolean; events: unknown[] }>;

  beforeEach(() => {
    savedHome = process.env.EDEN_HOME;
    savedKey = process.env.EDEN_API_KEY;
    savedBase = process.env.EDEN_BASE_URL;
    home = mkdtempSync(join(tmpdir(), "eden-drain-"));
    process.env.EDEN_HOME = home;
    process.env.EDEN_API_KEY = "eden_test";
    mkdirSync(join(home, "runs"), { recursive: true });
    ingested = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    for (const [k, v] of [
      ["EDEN_HOME", savedHome],
      ["EDEN_API_KEY", savedKey],
      ["EDEN_BASE_URL", savedBase],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** A site that accepts ingest and reports no live tools. */
  function serveSite(): void {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/v1/ingest") {
          ingested.push((await req.json()) as (typeof ingested)[number]);
          return Response.json({ ok: true });
        }
        if (u.pathname === "/v1/tools") return new Response("no", { status: 404 });
        return Response.json({ tools: [] });
      },
    });
    process.env.EDEN_BASE_URL = `http://127.0.0.1:${server.port}`;
  }

  function outbox(): string {
    const p = join(home, "outbox.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  test("a drained run is removed from the outbox instead of being re-sent forever", async () => {
    // dropRuns was populated only after a `continue` that the healthy path
    // always took, so rewriteOutbox removed nothing. The row was immortal and
    // every later drain re-POSTed stretch_end for a run that was still live.
    serveSite();
    const events = join(home, "runs", "r1.jsonl");
    appendJsonl(events, { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(events, { id: "e2", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r1", kind: "stretch_end", ts: Date.now() });

    await drain();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.stretch_end).toBe(true);
    expect(outbox()).not.toContain("r1");

    await drain();
    expect(ingested).toHaveLength(1);
  });

  test("an event written during the upload is not destroyed", async () => {
    // The "nothing had an id" fallback unlinked the whole events file, and it
    // ran outside the lock — so a PostToolUse hook that appended during the
    // in-flight POST lost its event.
    const events = join(home, "runs", "r2.jsonl");
    let late = false;
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/v1/ingest") {
          await req.json();
          if (!late) {
            late = true;
            appendJsonl(events, { id: "late", name: "Bash", args: {}, ok: true });
          }
          return Response.json({ ok: true });
        }
        if (u.pathname === "/v1/tools") return new Response("no", { status: 404 });
        return Response.json({ tools: [] });
      },
    });
    process.env.EDEN_BASE_URL = `http://127.0.0.1:${server.port}`;

    appendJsonl(events, { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(events, { id: "e2", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r2", kind: "stretch_end", ts: Date.now() });

    await drain();
    expect(existsSync(events)).toBe(true);
    expect(readFileSync(events, "utf8")).toContain("late");
  });

  test("an unreachable site leaves everything for the next attempt", async () => {
    // fetch rejects on ECONNREFUSED, and there was no try/catch in drain() —
    // so one unreachable plane threw out of the loop before the outbox
    // rewrite, making drain a permanent no-op rather than a retry.
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    const events = join(home, "runs", "r3.jsonl");
    appendJsonl(events, { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r3", kind: "stretch_end", ts: Date.now() });

    await drain();
    expect(readFileSync(events, "utf8")).toContain("e1");
    expect(outbox()).toContain("r3");
  });
});
