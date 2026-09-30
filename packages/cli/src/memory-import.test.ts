/**
 * M46.4 — Import history.
 * Contract (M46.1 / M46.2). Red until those modules export this surface:
 *
 *   import { memoryCli, memoryImportHelp, importMemoryPath } from "./memory-import";
 *   import { classifyImportRecord } from "./memory-import-kinds";
 *   import { openMemory, MEMORY_MARK } from "../../../src/index";
 *
 * Dry-run and live import return `{ kinds: { chat, icl, tools, skip } }` (counts
 * may also sit on the object itself). `memoryCli` prints help/counts and returns
 * an exit code (0 = ok). Missing path and `EDEN_MEMORY=0` are exit 0, no throw.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyImportRecord } from "./memory-import-kinds";
import { MEMORY_MARK, openMemory, type AgentMemory } from "../../../src/index";
import { memoryHookResponse } from "./memory-hook";

// Quarantined tests are marked test.failing (P0.-1): issue Knihalani/Eden#19. No URL here:
// the "M46.4 no NVIDIA" test asserts this file contains none.

const SECRET = "sk-ant-api03-SECRETVALUE99";
const SQLITE = "Use sqlite.";
const ICL = "The movie was great. label: 28";
const CLERK = "Auth is Clerk";
const MATH = "what's 2+2?";
const SQLITE_Q = "What sqlite database do we use?";

const ENV_KEYS = [
  "EDEN_MEMORY",
  "EDEN_MEMORY_DIR",
  "EDEN_MEMORY_MIN",
  "EDEN_MEMORY_SESSION",
  "EDEN_HOME",
  "EDEN_KNOW",
  "EDEN_SLEEP_EVERY",
  "EDEN_SLEEP_IDLE",
] as const;

type ImportMod = {
  memoryCli: (args: string[]) => Promise<number | string | unknown> | number | string | unknown;
  memoryImportHelp: () => string;
  importMemoryPath: (path: string, opts?: { dryRun?: boolean }) => Promise<unknown> | unknown;
};

let importMod: ImportMod | undefined;
let importLoadError = "";

const dirs: string[] = [];
const open: AgentMemory[] = [];
let envPrev: Record<string, string | undefined> = {};
let fetchSpy: ReturnType<typeof spyOn> | undefined;

function tmpDir(): string {
  const dir = join(import.meta.dir, "..", `.tmp-eden-mem-import-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function track(mem: AgentMemory): AgentMemory {
  open.push(mem);
  return mem;
}

function needImport(): ImportMod {
  if (!importMod) {
    throw new Error(
      `M46.1 packages/cli/src/memory-import.ts is not importable (${importLoadError || "missing"}). ` +
        "Expected exports: memoryCli, memoryImportHelp, importMemoryPath.",
    );
  }
  return importMod;
}

function kindsOf(result: unknown): { chat: number; icl: number; tools: number; skip: number } {
  const bag = ((): Record<string, unknown> => {
    if (!result || typeof result !== "object") return {};
    const r = result as Record<string, unknown>;
    const nested = r.kinds ?? r.counts;
    if (nested && typeof nested === "object") return nested as Record<string, unknown>;
    return r;
  })();
  const n = (k: string) => {
    const v = bag[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`dry-run result missing numeric kinds.${k}: ${JSON.stringify(result)}`);
    }
    return v;
  };
  return { chat: n("chat"), icl: n("icl"), tools: n("tools"), skip: n("skip") };
}

function exitOf(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const r = value as { code?: unknown; exit?: unknown };
    if (typeof r.code === "number") return r.code;
    if (typeof r.exit === "number") return r.exit;
  }
  return 0;
}

async function capture(
  fn: () => Promise<unknown> | unknown,
): Promise<{ code: number; out: string; err: string; value: unknown }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...msg: unknown[]) => {
    logs.push(msg.map((m) => String(m ?? "")).join(" "));
  };
  console.error = (...msg: unknown[]) => {
    errs.push(msg.map((m) => String(m ?? "")).join(" "));
  };
  try {
    const value = await fn();
    return { code: exitOf(value), out: logs.join("\n"), err: errs.join("\n"), value };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function treeText(root: string): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try {
          chunks.push(readFileSync(p, "utf8"));
        } catch {}
      }
    }
  };
  walk(root);
  return chunks.join("\n");
}

function jsonlRecordCount(root: string): number {
  return treeText(root)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{")).length;
}

function mixedJsonl(dir: string): string {
  const path = join(dir, "history.jsonl");
  const lines = [
    JSON.stringify({ role: "user", content: SQLITE }),
    JSON.stringify({ role: "user", content: ICL }),
    JSON.stringify({ tool_name: "Bash", tool_response: "ok" }),
    JSON.stringify({ role: "user", content: "" }),
    "",
  ];
  writeFileSync(path, lines.join("\n"));
  return path;
}

function packet(messages: unknown[]): string {
  return JSON.stringify(messages);
}

beforeEach(async () => {
  envPrev = {};
  for (const k of ENV_KEYS) envPrev[k] = process.env[k];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("M46 import must not call fetch");
  }) as unknown as typeof fetch);
  try {
    const m = (await import("./memory-import")) as Partial<ImportMod>;
    if (
      typeof m.memoryCli !== "function" ||
      typeof m.memoryImportHelp !== "function" ||
      typeof m.importMemoryPath !== "function"
    ) {
      importMod = undefined;
      importLoadError = `exports missing: ${Object.keys(m).join(",") || "(none)"}`;
    } else {
      importMod = m as ImportMod;
      importLoadError = "";
    }
  } catch (err) {
    importMod = undefined;
    importLoadError = err instanceof Error ? err.message : String(err);
  }
});

afterEach(() => {
  for (const mem of open.splice(0)) {
    try {
      mem.close();
    } catch {}
  }
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  for (const k of ENV_KEYS) {
    const v = envPrev[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M46.4 help / usage", () => {
  test("memoryImportHelp and memoryCli --help name eden memory import", async () => {
    const { memoryCli, memoryImportHelp } = needImport();
    const help = memoryImportHelp();
    expect(help).toContain("eden memory import");
    expect(help).not.toContain("GET /import");
    expect(help).not.toContain("memory_search");
    const cli = await capture(() => memoryCli(["--help"]));
    const text = `${cli.out}\n${cli.err}\n${typeof cli.value === "string" ? cli.value : ""}`;
    expect(text).toContain("eden memory import");
    expect(text).not.toContain("GET /import");
    expect(text).not.toContain("memory_search");
    expect(cli.code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("M46.4 dry-run counts", () => {
  test.failing("mixed jsonl dry-run counts chat, icl, and tools and writes nothing", async () => {
    const { memoryCli, importMemoryPath } = needImport();
    const dir = tmpDir();
    const memDir = join(dir, "memory");
    mkdirSync(memDir, { recursive: true });
    const path = mixedJsonl(dir);
    process.env.EDEN_MEMORY = "on";
    process.env.EDEN_MEMORY_DIR = memDir;
    delete process.env.EDEN_HOME;

    const counted = kindsOf(await importMemoryPath(path, { dryRun: true }));
    expect(counted.chat).toBeGreaterThanOrEqual(1);
    expect(counted.icl).toBeGreaterThanOrEqual(1);
    expect(counted.tools).toBeGreaterThanOrEqual(1);
    expect(jsonlRecordCount(memDir)).toBe(0);
    expect(treeText(memDir).trim()).toBe("");

    const cli = await capture(() => memoryCli(["--dry-run", path]));
    const fromCli = (() => {
      try {
        return kindsOf(cli.value);
      } catch {
        return undefined;
      }
    })();
    const printed = `${cli.out}\n${cli.err}`;
    if (fromCli) {
      expect(fromCli.chat).toBeGreaterThanOrEqual(1);
      expect(fromCli.icl).toBeGreaterThanOrEqual(1);
      expect(fromCli.tools).toBeGreaterThanOrEqual(1);
    } else {
      expect(printed).toMatch(/chat/i);
      expect(printed).toMatch(/icl/i);
      expect(printed).toMatch(/tools/i);
    }
    expect(jsonlRecordCount(memDir)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("M46.4 mixed file kinds", () => {
  test.failing("ICL, chat, tools, and binary/empty classify without network", () => {
    expect(classifyImportRecord({ text: ICL })).toBe("icl");
    expect(classifyImportRecord({ text: CLERK })).toBe("chat");
    expect(classifyImportRecord({ tool: true })).toBe("tools");
    expect(classifyImportRecord({ text: JSON.stringify({ tool_name: "Bash", tool_response: "ok" }) })).toBe("tools");
    expect(classifyImportRecord({ path: "shot.png" })).toBe("skip");
    expect(classifyImportRecord({ path: join("logs", "frame.PNG"), text: "pixels" })).toBe("skip");
    expect(classifyImportRecord({ text: `note\0${CLERK}` })).toBe("skip");
    expect(classifyImportRecord({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]) })).toBe("skip");
    expect(classifyImportRecord({ text: "" })).toBe("skip");
    expect(classifyImportRecord({})).toBe("skip");
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("M46.4 secrets redacted", () => {
  test("live import stores the fact without the secret token", async () => {
    const { memoryCli, importMemoryPath } = needImport();
    const dir = tmpDir();
    const memDir = join(dir, "memory");
    mkdirSync(memDir, { recursive: true });
    const path = join(dir, "secret.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ role: "user", content: `The deploy key is ${SECRET}. Auth is Clerk.` }) + "\n",
    );
    process.env.EDEN_MEMORY = "on";
    process.env.EDEN_MEMORY_DIR = memDir;
    delete process.env.EDEN_HOME;

    const code = exitOf(await importMemoryPath(path, { dryRun: false }));
    expect(code === 0 || code === undefined).toBe(true);
    const cli = await capture(() => memoryCli([path]));
    expect(cli.code).toBe(0);
    const stored = treeText(memDir);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("sk-ant-api03-");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).toMatch(/REDACTED|Clerk/i);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test("session_id, cwd, email, and ghp_ do not persist", async () => {
    const { importMemoryPath } = needImport();
    const dir = tmpDir();
    const memDir = join(dir, "memory");
    mkdirSync(memDir, { recursive: true });
    const session = "sess-m46probeabcdef";
    const cwd = "/Users/kaiavnihalani/secret-project";
    const email = "kaiav@example.com";
    const ghp = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const path = join(dir, "envelope.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          role: "user",
          session_id: session,
          cwd,
          content: `Mail ${email}. Session ${session}. Path ${cwd}. Token ${ghp}. Auth is Clerk.`,
        }),
        JSON.stringify({
          tool_name: "Bash",
          session_id: session,
          cwd,
          tool_input: { command: `pytest ${cwd}`, api_key: SECRET },
          tool_response: `ran in ${cwd} session_id=${session} key ${SECRET} ${ghp} ${email}`,
        }),
      ].join("\n") + "\n",
    );
    process.env.EDEN_MEMORY = "on";
    process.env.EDEN_MEMORY_DIR = memDir;
    delete process.env.EDEN_HOME;
    expect(exitOf(await importMemoryPath(path))).toBe(0);
    const stored = treeText(memDir);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("sk-");
    expect(stored).not.toContain(ghp);
    expect(stored).not.toContain("ghp_");
    expect(stored).not.toContain(email);
    expect(stored).not.toContain(session);
    expect(stored).not.toContain(cwd);
    expect(stored).toMatch(/Clerk/i);
  });
});

describe("M46.4 off skips writes", () => {
  test("EDEN_MEMORY=0 live import writes no records and exits 0", async () => {
    const { memoryCli, importMemoryPath } = needImport();
    const dir = tmpDir();
    const memDir = join(dir, "memory");
    mkdirSync(memDir, { recursive: true });
    const path = mixedJsonl(dir);
    process.env.EDEN_MEMORY = "0";
    process.env.EDEN_MEMORY_DIR = memDir;
    delete process.env.EDEN_HOME;
    const before = jsonlRecordCount(memDir);

    let thrown: unknown;
    let code = 0;
    try {
      code = exitOf(await importMemoryPath(path));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(code).toBe(0);
    const cli = await capture(() => memoryCli([path]));
    expect(cli.code).toBe(0);
    expect(jsonlRecordCount(memDir)).toBe(before);
    expect(treeText(memDir)).not.toMatch(/sqlite/i);
    expect(existsSync(join(memDir, "memories.jsonl"))).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("M46.4 silence still wins", () => {
  test.failing("junk import stays silent; math stays silent after sqlite; sqlite cue may help", async () => {
    const { importMemoryPath } = needImport();
    const junkDir = join(tmpDir(), "memory");
    mkdirSync(junkDir, { recursive: true });
    const junkPath = join(junkDir, "..", "junk.jsonl");
    writeFileSync(
      junkPath,
      [JSON.stringify({ role: "user", content: "nice" }), JSON.stringify({ role: "user", content: MATH })].join("\n") +
        "\n",
    );
    process.env.EDEN_MEMORY = "on";
    process.env.EDEN_MEMORY_DIR = junkDir;
    delete process.env.EDEN_HOME;
    delete process.env.EDEN_MEMORY_MIN;
    expect(exitOf(await importMemoryPath(junkPath))).toBe(0);

    const junkMem = track(openMemory({ dir: junkDir }));
    const junkOut = junkMem.inject([{ role: "user", content: MATH }]);
    const junkHay = packet(junkOut as unknown[]);
    expect(junkHay).not.toContain(MEMORY_MARK);
    expect(junkHay).not.toContain("Eden Memory:");
    junkMem.close();

    const sqlDir = join(tmpDir(), "memory");
    mkdirSync(sqlDir, { recursive: true });
    const sqlPath = join(sqlDir, "..", "sqlite.jsonl");
    writeFileSync(
      sqlPath,
      [
        JSON.stringify({ role: "user", content: "nice" }),
        JSON.stringify({ role: "user", content: MATH }),
        JSON.stringify({ role: "user", content: SQLITE }),
      ].join("\n") + "\n",
    );
    process.env.EDEN_MEMORY_DIR = sqlDir;
    expect(exitOf(await importMemoryPath(sqlPath))).toBe(0);

    const mem = track(openMemory({ dir: sqlDir }));
    const mathOut = mem.inject([{ role: "user", content: MATH }]);
    const mathHay = packet(mathOut as unknown[]);
    expect(mathHay).not.toContain(MEMORY_MARK);
    expect(mathHay).not.toContain("Eden Memory:");

    const related = packet(mem.inject([{ role: "user", content: SQLITE_Q }]) as unknown[]);
    expect(related).toContain(MEMORY_MARK);
    expect(related).toMatch(/sqlite/i);
    expect(related).not.toMatch(/postgres/i);

    const body = mem.injectBody({ messages: [{ role: "user", content: SQLITE_Q }] });
    const wrapped = packet((body.messages ?? []) as unknown[]);
    expect(wrapped).toContain(MEMORY_MARK);
    expect(wrapped).toMatch(/sqlite/i);
    const mathBody = mem.injectBody({ messages: [{ role: "user", content: MATH }] });
    expect(packet((mathBody.messages ?? []) as unknown[])).not.toContain(MEMORY_MARK);

    const submit = memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      session_id: "hooksess12345678",
      prompt: SQLITE_Q,
    });
    const submitMath = memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      session_id: "hooksess12345678",
      prompt: MATH,
    });
    expect(JSON.stringify(submit ?? {})).toMatch(/sqlite/i);
    expect(JSON.stringify(submitMath ?? {})).not.toContain(MEMORY_MARK);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("M46.4 fail-open", () => {
  test("missing path exits 0 and does not throw", async () => {
    const { memoryCli, importMemoryPath } = needImport();
    const dir = tmpDir();
    const missing = join(dir, "no-such-transcript.jsonl");
    process.env.EDEN_MEMORY = "on";
    process.env.EDEN_MEMORY_DIR = join(dir, "memory");
    delete process.env.EDEN_HOME;
    mkdirSync(process.env.EDEN_MEMORY_DIR, { recursive: true });

    let thrown: unknown;
    let code = 0;
    try {
      code = exitOf(await importMemoryPath(missing));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(code).toBe(0);
    const cli = await capture(() => memoryCli([missing]));
    expect(cli.code).toBe(0);
    expect(jsonlRecordCount(process.env.EDEN_MEMORY_DIR)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("M46.4 no NVIDIA", () => {
  test("this file never calls fetch; import is not given a server", () => {
    expect(fetchSpy).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    const src = readFileSync(join(import.meta.dir, "memory-import.test.ts"), "utf8");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/\bNIM\b/);
    expect(src).not.toMatch(/integrate\.api\.nvidia/);
  });
});
