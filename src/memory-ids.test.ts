/**
 * P0.3 (ROADMAP; A4 §1; A1 D2, D3, D6, D8): row ids are ULIDs, every row carries a per-store `seq` assigned under
 * the store lock (or waits in `pending.jsonl` for sleep) and its wall time `t`, validity survives a reload, list
 * numbers are not clocks, and ages are real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, settlePendingRows, storeRows, superseded } from "./index";
import { takePending } from "./memory-ids";
import { storeFor } from "./memory-repo";
import { readInvalidations } from "./memory-validity";
import { ageInWords } from "./memory-hook-packet";
import { provenanceBracket } from "./memory-provenance";
import { SemanticStore } from "./semantic-store";
import { sleep } from "./sleep";
import { cuesBelowTau } from "../scripts/test-below-tau";

cuesBelowTau();

const REPO = join(import.meta.dir, "..");
const HOOK = join(REPO, "plugins", "eden-memory", "scripts", "hook.ts");
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-09-01T09:00:00.000Z");

const dirs: string[] = [];
const saved = { now: process.env.EDEN_NOW, dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME };
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_NOW", saved.now],
    ["EDEN_MEMORY_DIR", saved.dir],
    ["EDEN_HOME", saved.home],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-ids-"));
  dirs.push(dir);
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  return join(dir, "memory");
}

type DiskRow = Record<string, unknown> & { id: string; text: string };

/** The rows of one session's store (or, with `""`, of a repo's store) as they are on disk. */
function diskRows(root: string, session: string): DiskRow[] {
  const path = join(root, session, "memories.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? { id: parsed[0], text: parsed[1] } : parsed;
    });
}

const rowWith = (rows: DiskRow[], words: string) => rows.find((row) => row.text.includes(words));

/** One hook process, as Claude Code runs it, with `process.pid` pinned by a preload. */
function submitAs(pid: number, root: string, prompt: string): void {
  const preload = join(root, "..", `pid-${pid}.ts`);
  writeFileSync(preload, `Object.defineProperty(process, "pid", { value: ${pid}, configurable: true });\n`);
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "s98", prompt, cwd: REPO, transcript_path: "" };
  const run = Bun.spawnSync(["bun", "--preload", preload, HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, EDEN_MEMORY_DIR: root, EDEN_HOME: join(root, "..", "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
}

describe("#98, A1 D2: row ids", () => {
  test("two writer processes with the same pid % 36, one after the other, both keep their rows", () => {
    const root = tempRoot();
    submitAs(1022, root, "The build tag for module alpha is tag-alpha.");
    submitAs(1058, root, "The build tag for module beta is tag-beta.");
    const rows = diskRows(storeFor(root, REPO), "");
    expect(rowWith(rows, "tag-alpha")).toBeDefined();
    expect(rowWith(rows, "tag-beta")).toBeDefined();
  });

  test("row ids are ULIDs, distinct, and sort in creation order", () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    const first = mem.remember("The build tag for module alpha is tag-alpha.");
    const second = mem.remember("The build tag for module beta is tag-beta.");
    mem.close();
    expect(first.id).toMatch(ULID);
    expect(second.id).toMatch(ULID);
    expect(first.id < second.id).toBe(true);
  });
});

describe("A4 §1: seq and t", () => {
  test("every persisted row carries a per-store seq, increasing across stores and processes, and its time t", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const one = openMemory({ dir: root, session: "s1" });
    one.remember("The build tag for module alpha is tag-alpha.");
    one.close();
    process.env.EDEN_NOW = String(T0 + 1_000);
    const two = openMemory({ dir: root, session: "s2" });
    two.remember("The build tag for module beta is tag-beta.");
    two.close();
    const alpha = rowWith(diskRows(root, "s1"), "tag-alpha")!;
    const beta = rowWith(diskRows(root, "s2"), "tag-beta")!;
    expect(alpha.t).toBe(T0);
    expect(beta.t).toBe(T0 + 1_000);
    expect(typeof alpha.seq).toBe("number");
    expect(beta.seq as number).toBeGreaterThan(alpha.seq as number);
  });

  test("a writer that cannot take the store lock within 50 ms leaves its rows in pending.jsonl; sleep gives them a seq", async () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
    const started = performance.now();
    mem.remember("The build tag for module alpha is tag-alpha.");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rowWith(diskRows(root, "s1"), "tag-alpha")).toBeUndefined();
    expect(readFileSync(join(root, "pending.jsonl"), "utf8")).toContain("tag-alpha");
    rmSync(join(root, ".lock"));
    await sleep({ dir: root, session: "s1", mem });
    mem.close();
    expect(typeof rowWith(diskRows(root, "s1"), "tag-alpha")?.seq).toBe("number");
    const left = join(root, "pending.jsonl");
    expect(existsSync(left) ? readFileSync(left, "utf8") : "").not.toContain("tag-alpha");
  });
});

describe("A1 D3: validity survives a reload", () => {
  test("a superseded value stays invalid in the next process: invalid_at is the superseding row's seq", () => {
    const root = tempRoot();
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("The auth provider is Auth0.");
    first.remember("The auth provider is Clerk.");
    first.close();
    const rows = diskRows(root, "s1");
    expect(rowWith(rows, "Auth0")?.invalid_at).toBe(rowWith(rows, "Clerk")?.seq);
    const next = openMemory({ dir: root, session: "s1" });
    const recalled = next.recall([{ role: "user", content: "which auth provider do we use?" }]).map((r) => r.text);
    next.close();
    expect(recalled.join("\n")).toContain("Clerk");
    expect(recalled.join("\n")).not.toContain("Auth0");
  });

  test("a rule's valid_until survives a reload and ends it", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("Use the staging database for the zebra tests until 2026-09-15.");
    first.close();
    expect(rowWith(diskRows(root, "s1"), "staging")?.valid_until).toBe(Date.parse("2026-09-15"));
    process.env.EDEN_NOW = String(T0 + 30 * DAY_MS);
    const later = openMemory({ dir: root, session: "s1" });
    const recalled = later.recall([{ role: "user", content: "which database for the zebra tests?" }]);
    later.close();
    expect(recalled.map((r) => r.text).join("\n")).not.toContain("staging");
  });
});

describe("A1 D8: list numbers are not clocks", () => {
  const recallIn = (root: string, cue: string) => {
    const mem = openMemory({ dir: root, session: "s1" });
    const texts = mem.recall([{ role: "user", content: cue }]).map((r) => r.text);
    mem.close();
    return texts.join("\n");
  };

  test("a later plain statement supersedes a numbered item, in the rows and in the semantic store", () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    mem.remember("1. The database is sqlite");
    mem.remember("The database is postgres.");
    mem.close();
    const recalled = recallIn(root, "what database do we use?");
    expect(recalled).toContain("postgres");
    expect(recalled).not.toContain("sqlite");
    expect(new SemanticStore(root).get("database", "is")?.o).toBe("postgres");
  });

  test("a later numbered item supersedes an earlier plain statement", () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    mem.remember("The database is postgres.");
    mem.remember("2. The database is sqlite");
    mem.close();
    const recalled = recallIn(root, "what database do we use?");
    expect(recalled).toContain("sqlite");
    expect(recalled).not.toContain("postgres");
    expect(new SemanticStore(root).get("database", "is")?.o).toBe("sqlite");
  });
});

describe("A1 D6: real ages", () => {
  test("EDEN_NOW is the clock rows are stamped with", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const mem = openMemory({ dir: root, session: "s1" });
    expect(mem.remember("The build tag for module alpha is tag-alpha.").at).toBe(T0);
    mem.close();
  });

  test("a reloaded row keeps its time, so its age is how long ago it was said", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("The build tag for module alpha is tag-alpha.");
    first.close();
    process.env.EDEN_NOW = String(T0 + 3 * DAY_MS);
    const later = openMemory({ dir: root, session: "s1" });
    const row = later.memories().find((r) => r.text.includes("tag-alpha"))!;
    later.close();
    expect(row.at).toBe(T0);
    expect(ageInWords(row.at, T0 + 3 * DAY_MS)).toBe("3 days ago");
  });

  test("a row without a time claims no age", () => {
    expect(provenanceBracket({ text: "The database is postgres.", kind: "fact" }, "fact")).toBe("[fact · user]");
  });
});

describe("P0.2 follow-up: validity against real row times", () => {
  test("a value restated after its retraction is delivered again; the retracted statement is not", async () => {
    const root = tempRoot();
    const { memoryHookResponse } = await import("../packages/cli/src/memory-hook");
    const submit = (prompt: string, at: number) => {
      process.env.EDEN_NOW = String(at);
      const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt, cwd: REPO });
      const spec = out?.hookSpecificOutput as { additionalContext?: string } | undefined;
      return spec?.additionalContext ?? "";
    };
    submit("We cache sessions in Redis.", T0);
    submit("We no longer use Redis.", T0 + DAY_MS);
    submit("We cache sessions in Redis again, with a one hour TTL.", T0 + 2 * DAY_MS);
    const packet = submit("where do we cache sessions?", T0 + 3 * DAY_MS);
    expect(packet).toContain("Redis again");
    expect(packet).not.toContain("We cache sessions in Redis.");
    expect(existsSync(join(storeFor(root, REPO), "validity.jsonl"))).toBe(true);
  });
});

describe("A4 §3.1, D12: only a later typed statement re-learns a superseded value (review round 1)", () => {
  const conversation = [
    { role: "user", content: "The database is sqlite." },
    { role: "user", content: "The database is postgres." },
  ];
  const liveDatabase = (mem: ReturnType<typeof openMemory>) =>
    mem
      .memories()
      .filter((r) => r.kind === "fact" && /database is/i.test(r.text) && !superseded(r))
      .map((r) => r.text);

  function afterReading(last?: { role: string; content: string; src?: string }): string[] {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    mem.observe(conversation.slice(0, 1));
    mem.observe(conversation);
    mem.observe(last ? [...conversation, last] : conversation);
    const live = liveDatabase(mem);
    mem.close();
    return live;
  }

  test("a plain re-read of the conversation changes nothing", () => {
    expect(afterReading()).toEqual(["The database is postgres"]);
  });

  test("the assistant's or a tool's echo of the old value changes nothing", () => {
    expect(afterReading({ role: "assistant", content: "The README still says this. The database is sqlite." })).toEqual(
      ["The database is postgres"],
    );
    expect(afterReading({ role: "user", content: "# README\n\nThe database is sqlite.", src: "tool" })).toEqual([
      "The database is postgres",
    ]);
  });

  test("the user typing the old value again brings it back", () => {
    expect(afterReading({ role: "user", content: "Sorry, I was wrong. The database is sqlite." })).toEqual([
      "The database is sqlite",
    ]);
  });
});

describe("A4 §1: a pending row never beats a later statement (review round 1)", () => {
  const holdLock = (root: string) =>
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
  const liveAfterSleep = async (root: string) => {
    const mem = openMemory({ dir: root, session: "s1" });
    await sleep({ dir: root, session: "s1", mem });
    mem.close();
    return storeRows(join(root, "s1", "memories.jsonl"))
      .filter((r) => /database is/i.test(r.text) && !superseded(r))
      .map((r) => r.text);
  };

  test("one process: a row it left pending and then superseded stays superseded", async () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    mem.remember("The build tag for module alpha is tag-alpha.");
    holdLock(root);
    mem.remember("The database is sqlite.");
    rmSync(join(root, ".lock"));
    mem.remember("The database is postgres.");
    mem.close();
    expect(await liveAfterSleep(root)).toEqual(["The database is postgres."]);
  });

  test("two processes: a row left pending is older than a statement stored after it", async () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("The build tag for module alpha is tag-alpha.");
    holdLock(root);
    first.remember("The database is sqlite.");
    first.close();
    rmSync(join(root, ".lock"));
    process.env.EDEN_NOW = String(T0 + 60_000);
    const second = openMemory({ dir: root, session: "s1" });
    second.remember("The database is postgres.");
    second.close();
    expect(await liveAfterSleep(root)).toEqual(["The database is postgres."]);
  });

  test("a line appended to pending.jsonl after a sleep took it is kept for the next sleep", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const line = (id: string) => `${JSON.stringify({ store: "s1", row: { id, text: `row ${id}`, t: T0 } })}\n`;
    writeFileSync(join(root, "pending.jsonl"), line("01J9AAAAAAAAAAAAAAAAAAAAAA"));
    const taken = takePending(root)!;
    const [takenFile] = readdirSync(root).filter((name) => name.startsWith("pending.jsonl."));
    appendFileSync(join(root, takenFile!), line("01J9BBBBBBBBBBBBBBBBBBBBBB"));
    taken.done();
    expect(readFileSync(join(root, "pending.jsonl"), "utf8")).toContain("01J9BBBBBBBBBBBBBBBBBBBBBB");
    expect(readFileSync(join(root, "pending.jsonl"), "utf8")).not.toContain("01J9AAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("review round 2", () => {
  test("a hook's re-read of a lagging transcript never revives the value the prompt replaced", async () => {
    const root = tempRoot();
    const { memoryHookResponse } = await import("../packages/cli/src/memory-hook");
    const transcript = join(root, "..", "transcript.jsonl");
    // The transcript holds the first prompt only: the second prompt's line has not been flushed yet (R0 F8).
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "The database is sqlite." } })}\n`,
    );
    const event = (hook_event_name: string, prompt?: string) =>
      memoryHookResponse({ hook_event_name, session_id: "s1", prompt, cwd: REPO, transcript_path: transcript });
    event("UserPromptSubmit", "The database is sqlite.");
    event("UserPromptSubmit", "The database is postgres.");
    event("Stop");
    event("UserPromptSubmit", "Reply with just OK.");
    const live = storeRows(join(storeFor(root, REPO), "memories.jsonl"))
      .filter((r) => r.kind === "fact" && /database is/i.test(r.text) && !superseded(r))
      .map((r) => r.text);
    expect(live).toEqual(["The database is postgres"]);
  });

  test("reading the conversation again after sleep superseded a value never learns it anew", async () => {
    for (const [older, newer] of [
      ["Use postgres", "Use sqlite instead"],
      ["The chairperson of the committee is Alice.", "The chairperson of the committee is Bob."],
    ]) {
      const conversation = [
        { role: "user", content: older! },
        { role: "user", content: newer! },
      ];
      for (const reread of [true, false]) {
        const root = tempRoot();
        const mem = openMemory({ dir: root, session: "s1" });
        mem.observe(conversation.slice(0, 1));
        mem.observe(conversation, { reread });
        await sleep({ dir: root, session: "s1", mem });
        mem.observe(conversation, { reread });
        const live = mem.memories().filter((r) => r.kind === "fact" && !superseded(r));
        mem.close();
        expect(live.some((r) => /postgres|Alice/.test(r.text))).toBe(false);
      }
    }
  });

  test("settling a stored row's pending copy keeps the stored text and takes the copy's supersession", async () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    const row = mem.remember("The build tag for module alpha is tag-alpha.");
    mem.close();
    const stored = storeRows(join(root, "s1", "memories.jsonl"))[0]!;
    const copy = {
      id: row.id,
      text: "an older copy of the text",
      t: row.at,
      seq: stored.seq,
      invalid_by: "01J9ZZZZZZZZZZZZZZZZZZZZZZ",
    };
    writeFileSync(join(root, "pending.jsonl"), `${JSON.stringify({ store: "s1", row: copy })}\n`);
    settlePendingRows(root);
    const after = storeRows(join(root, "s1", "memories.jsonl"))[0]!;
    expect(after.text).toBe(stored.text);
    expect(after.seq).toBe(stored.seq);
    expect(after.invalidBy).toBe("01J9ZZZZZZZZZZZZZZZZZZZZZZ");
  });

  test("a supersession decided while settling marks older text stating the old value stale (D31)", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("The build tag for module alpha is tag-alpha.");
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
    first.remember("The database is sqlite.");
    first.close();
    rmSync(join(root, ".lock"));
    // The second writer never sees the pending row, so only the settle can supersede it.
    process.env.EDEN_NOW = String(T0 + 60_000);
    const second = openMemory({ dir: root, session: "s1" });
    second.remember("The database is postgres.");
    second.close();
    expect(existsSync(join(root, "validity.jsonl"))).toBe(false);
    settlePendingRows(root);
    expect(readInvalidations(root)).toEqual([
      { k: "retract", o: "sqlite", f: "sqlite", t: T0 + 60_000, w: ["database"] },
    ]);
  });

  test("finishing a taken pending file another sleep already removed is not an error", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "pending.jsonl"),
      `${JSON.stringify({ store: "s1", row: { id: "01J9AAAAAAAAAAAAAAAAAAAAAA", text: "x", t: T0 } })}\n`,
    );
    const taken = takePending(root)!;
    for (const name of readdirSync(root).filter((n) => n.startsWith("pending.jsonl."))) rmSync(join(root, name));
    expect(() => taken.done()).not.toThrow();
  });
});

describe("SessionEnd encodes and does not sleep (Claude Code cancels it at 1.5 s, R0)", () => {
  test("it encodes what the session added and leaves the sleep to the Stop before it", async () => {
    const root = tempRoot();
    const { memoryHookResponse } = await import("../packages/cli/src/memory-hook");
    const end = (hook_event_name: string, last_assistant_message: string) =>
      memoryHookResponse({ hook_event_name, session_id: "s1", cwd: REPO, transcript_path: "", last_assistant_message });
    end("Stop", "The build tag for module alpha is tag-alpha.");
    const store = storeFor(root, REPO);
    const gists = () =>
      existsSync(join(store, "gists.jsonl")) ? readFileSync(join(store, "gists.jsonl"), "utf8") : "";
    const afterStop = gists();
    end("SessionEnd", "The build tag for module beta is tag-beta.");
    expect(storeRows(join(store, "memories.jsonl")).some((r) => r.text.includes("tag-beta"))).toBe(true);
    expect(gists()).toBe(afterStop);
  });
});
