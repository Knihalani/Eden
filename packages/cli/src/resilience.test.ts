import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  utimesSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { appendJsonl, ensureHome, eventsPath, safeRunId, withFileLock, writeConfig } from "./home";
import { handleHookd } from "./hookd";
import { HOOKD_KEY_HEADER, ensureHookdKey } from "./hookd-key";
import { applyFlushTruncate, respondToHook } from "./hook";
import { rewriteOutbox } from "./drain";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.EDEN_HOME;
  home = mkdtempSync(join(tmpdir(), "eden-home-"));
  process.env.EDEN_HOME = home;
  mkdirSync(join(home, "runs"), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.EDEN_HOME;
  else process.env.EDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("run ids cannot escape the runs directory", () => {
  test("traversal is folded to a hashed name inside runs/", () => {
    for (const hostile of ["../../victim/private", "..", "/etc/passwd", "a/../../b"]) {
      const p = eventsPath(hostile);
      expect(p.startsWith(join(home, "runs") + "/")).toBe(true);
      expect(p).not.toContain("..");
      expect(safeRunId(hostile)).toMatch(/^sess_[0-9a-f]{32}$/);
    }
  });

  test("ordinary ids are left exactly as they are", () => {
    for (const id of ["local", "abc-123_DEF", "0", "a".repeat(128)]) {
      expect(safeRunId(id)).toBe(id);
    }
    expect(eventsPath("local")).toBe(join(home, "runs", "local.jsonl"));
  });

  test("the same hostile id always maps to the same file", () => {
    expect(safeRunId("../../x")).toBe(safeRunId("../../x"));
    expect(safeRunId("../../x")).not.toBe(safeRunId("../../y"));
  });
});

describe("hookd refuses drive-by callers", () => {
  // Each request carries the hookd key, so each test isolates the check it names.
  const keyed = () => ({ "content-type": "application/json", [HOOKD_KEY_HEADER]: ensureHookdKey() });
  const post = (headers: Record<string, string> = {}, path = "/hook") =>
    new Request(`http://127.0.0.1:8794${path}`, {
      method: "POST",
      headers: { ...keyed(), ...headers },
      body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "local" }),
    });

  test("rejects a request carrying an Origin", async () => {
    const res = await handleHookd(post({ origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  test("rejects a cross-site fetch", async () => {
    const res = await handleHookd(post({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  test("rejects an unexpected path", async () => {
    const res = await handleHookd(post({}, "/v1/ingest"));
    expect(res.status).toBe(404);
  });

  test("still serves the local hook caller", async () => {
    const res = await handleHookd(post());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  test("rejects a rebound hostname even though it looks same-origin", async () => {
    // Under DNS rebinding both existing signals are useless: they are relative
    // to an origin whose *name* the attacker controls. A page on
    // http://evil.test:8794 that re-resolves to 127.0.0.1 is same-origin as
    // far as the browser is concerned, so it sends no Origin and
    // Sec-Fetch-Site: same-origin. Host still carries the name the client
    // asked for.
    const res = await handleHookd(
      new Request("http://127.0.0.1:8794/hook", {
        method: "POST",
        headers: {
          ...keyed(),
          host: "evil.test:8794",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "local" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("accepts the loopback names a real local caller uses", async () => {
    for (const host of ["127.0.0.1:8794", "localhost:8794", "[::1]:8794", "127.0.0.1"]) {
      const res = await handleHookd(
        new Request("http://127.0.0.1:8794/hook", {
          method: "POST",
          headers: { ...keyed(), host },
          body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "local" }),
        }),
      );
      expect(res.status).toBe(200);
    }
  });
});

describe("the hook never blocks the agent", () => {
  test("does not deny in favour of a tool with no name", async () => {
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ sequence: ["Bash"] }]));
    const out = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1" });
    expect(out).toEqual({ ok: true });
  });

  test("survives a live-tools.json that is not an array", async () => {
    writeFileSync(join(home, "live-tools.json"), JSON.stringify({ knock: null }));
    await expect(
      respondToHook({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1" }),
    ).resolves.toEqual({ ok: true });
  });

  test("survives a corrupt live-tools.json", async () => {
    writeFileSync(join(home, "live-tools.json"), "{not json");
    await expect(
      respondToHook({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1" }),
    ).resolves.toEqual({
      ok: true,
    });
  });

  test("still denies when the compiled tool is properly named (opt-in steering)", async () => {
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ name: "bundle", sequence: ["Bash"] }]));
    process.env.EDEN_STEER_HOOKS = "1";
    try {
      const out = (await respondToHook({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1" })) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("bundle");
    } finally {
      delete process.env.EDEN_STEER_HOOKS;
    }
  });
});

describe("withFileLock", () => {
  test("breaks a lock left behind by a dead process", () => {
    const lock = join(home, "runs", "stale.jsonl.lock");
    closeSync(openSync(lock, "w"));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);

    const t0 = Date.now();
    expect(withFileLock(lock, () => "done")).toBe("done");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(existsSync(lock)).toBe(false);
  });

  test("a fresh lock is still respected", () => {
    const lock = join(home, "runs", "fresh.jsonl.lock");
    closeSync(openSync(lock, "w"));
    const now = new Date(Date.now());
    utimesSync(lock, now, now);
    expect(() => withFileLock(lock, () => "nope")).toThrow(/could not acquire lock/);
    rmSync(lock, { force: true });
  });

  test("reports the callback's own error, once, not as lock contention", () => {
    const lock = join(home, "runs", "boom.jsonl.lock");
    let calls = 0;
    expect(() =>
      withFileLock(lock, () => {
        calls++;
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(calls).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  test("appends survive the lock being taken and released", () => {
    const path = eventsPath("s2");
    for (let i = 0; i < 5; i++) {
      withFileLock(`${path}.lock`, () => writeFileSync(path, `${readFileSafe(path)}line${i}\n`));
    }
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(5);
  });

  test("does not break the lock of a holder that is merely slow", () => {
    const lock = join(home, "runs", "slow.jsonl.lock");
    let reentered = false;
    withFileLock(lock, () => {
      const old = new Date(Date.now() - 120_000);
      utimesSync(lock, old, old);
      expect(() => withFileLock(lock, () => (reentered = true))).toThrow(/could not acquire lock/);
    });
    expect(reentered).toBe(false);
  });

  test("a holder does not delete a lock that is no longer its own", () => {
    const lock = join(home, "runs", "stolen.jsonl.lock");
    withFileLock(lock, () => {
      rmSync(lock, { force: true });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
    });
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { force: true });
  });

  test("recovers immediately from a crashed holder rather than waiting out the horizon", () => {
    const lock = join(home, "runs", "crashed.jsonl.lock");
    writeFileSync(lock, JSON.stringify({ pid: 0x7ffffffe, host: hostname(), ts: Date.now() }));
    const t0 = Date.now();
    expect(withFileLock(lock, () => "done")).toBe("done");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(existsSync(lock)).toBe(false);
  });

  test("breaking an abandoned lock does not delete the lock that replaced it", () => {
    const lock = join(home, "runs", "swapped.jsonl.lock");
    writeFileSync(lock, JSON.stringify({ pid: 0x7ffffffe, host: hostname(), ts: Date.now() }));

    rmSync(lock, { force: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
    const liveBody = readFileSync(lock, "utf8");

    expect(() => withFileLock(lock, () => "nope")).toThrow(/could not acquire lock/);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(liveBody);
    rmSync(lock, { force: true });
  });

  test("a lock claiming a live pid is still broken once it is absurdly old", () => {
    const lock = join(home, "runs", "wedged.jsonl.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
    const ancient = new Date(Date.now() - 3_600_000);
    utimesSync(lock, ancient, ancient);
    expect(withFileLock(lock, () => "done")).toBe("done");
  });

  test("a lock held from another machine still falls back to the age horizon", () => {
    // pid liveness says nothing about a different host, so those locks keep the
    // old age-based recovery instead of wedging forever.
    const lock = join(home, "runs", "remote.jsonl.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: `${hostname()}-elsewhere`, ts: Date.now() }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => "done")).toBe("done");
  });
});

function readFileSafe(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("drain does not lose events", () => {
  test("rewriteOutbox leaves a trailing newline so the next append is safe", () => {
    // Without it, appendJsonl() concatenates onto the last record and destroys
    // two rows: the one it lands on and its own. stretch_end markers live in
    // this file, so a swallowed marker means the run never clusters.
    const before =
      JSON.stringify({ run_id: "gone", kind: "stretch_end", ts: 1 }) +
      "\n" +
      JSON.stringify({ run_id: "keep", kind: "stretch_end", ts: 2 }) +
      "\n";
    const after = rewriteOutbox(before, new Set(["gone"]));
    expect(after.endsWith("\n")).toBe(true);

    const path = join(home, "outbox.jsonl");
    writeFileSync(path, after);
    appendJsonl(path, { run_id: "new", kind: "stretch_end", ts: 3 });
    const ids = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return (JSON.parse(l) as { run_id?: string }).run_id;
        } catch {
          return "PARSE_FAIL";
        }
      });
    expect(ids).toEqual(["keep", "new"]);
  });

  test("rewriteOutbox on an empty result stays empty", () => {
    expect(rewriteOutbox("", new Set())).toBe("");
    expect(rewriteOutbox(JSON.stringify({ run_id: "x", kind: "stretch_end" }) + "\n", new Set(["x"]))).toBe("");
  });

  test("applyFlushTruncate keeps events that arrived during the upload", () => {
    // drain read the file, awaited a POST, then unlinked it — so a PostToolUse
    // firing inside that window wrote an event into a file that was destroyed.
    // Removing exactly the sent ids keeps the late one.
    const path = eventsPath("s3");
    appendJsonl(path, { id: "e1", name: "Bash" });
    appendJsonl(path, { id: "e2", name: "Bash" });
    const sent = ["e1", "e2"];
    appendJsonl(path, { id: "late", name: "Bash" }); // arrives mid-flight
    withFileLock(`${path}.lock`, () => applyFlushTruncate(path, sent));
    const left = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { id: string }).id);
    expect(left).toEqual(["late"]);
  });

  test("applyFlushTruncate with nothing confirmed sent deletes nothing", () => {
    // "No ids to drop" used to fall through to "keep nothing", so a caller that
    // passed an empty or all-blank id list wiped the entire log. The safe
    // reading of an empty drop set is to leave the file alone.
    const path = eventsPath("s4");
    appendJsonl(path, { id: "e1", name: "Bash" });
    appendJsonl(path, { id: "e2", name: "Bash" });
    const before = readFileSync(path, "utf8");

    applyFlushTruncate(path, []);
    expect(readFileSync(path, "utf8")).toBe(before);

    applyFlushTruncate(path, ["", ""]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("applyFlushTruncate replaces the log atomically", () => {
    // Rewriting in place truncates first and writes second: a crash, a full
    // disk or a power loss in between leaves the log empty or ending in half a
    // record, which readJsonl cannot parse. The replacement goes through a
    // temp file and a rename, and leaves no temp file behind.
    const path = eventsPath("s5");
    appendJsonl(path, { id: "e1", name: "Bash" });
    appendJsonl(path, { id: "keep", name: "Bash" });
    applyFlushTruncate(path, ["e1"]);

    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ id: "keep", name: "Bash" })}\n`);
    const strays = readdirSync(join(home, "runs")).filter((f) => f.endsWith(".tmp"));
    expect(strays).toEqual([]);
  });

  test("applyFlushTruncate does not rewrite the log when no id matches", () => {
    // A no-op rewrite is still a truncate-and-write window for no benefit.
    const path = eventsPath("s6");
    appendJsonl(path, { id: "e1", name: "Bash" });
    const before = statSync(path).mtimeMs;
    applyFlushTruncate(path, ["not-in-this-file"]);
    expect(statSync(path).mtimeMs).toBe(before);
  });
});

describe("eden home does not leave credentials world-readable", () => {
  test("rewriting an existing config restores 0600", () => {
    // `mode` on writeFileSync applies only when the file is created. A
    // config.json that already existed with 0644 — written before the flag was
    // added, created by an editor, restored from a backup — kept that mode
    // through every later setup, and it holds the API key.
    const p = join(home, "config.json");
    writeFileSync(p, "{}", { mode: 0o644 });
    expect(statSync(p).mode & 0o777).toBe(0o644);

    writeConfig({ api_key: "eden_secret", base_url: "http://127.0.0.1:8788" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("the home directory and the run logs are not readable by other users", () => {
    // runs/*.jsonl is the complete recorded tool history of every session.
    ensureHome();
    expect(statSync(home).mode & 0o077).toBe(0);
    expect(statSync(join(home, "runs")).mode & 0o077).toBe(0);
  });
});
