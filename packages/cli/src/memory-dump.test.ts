import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { appendTurn, windowDir } from "../../../src/memory-window";

const CLI = join(import.meta.dir, "cli.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dump(root: string, args = ["--json"]) {
  const run = Bun.spawnSync(["bun", CLI, "memory", "dump", ...args], {
    env: { ...process.env, EDEN_MEMORY_DIR: root, EDEN_HOME: join(root, "..", "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, out: run.stdout.toString() };
}

describe("eden memory dump --json (the spawn-writers arm's contract)", () => {
  test("prints every store's rows, the rows waiting for a seq, and every window's ledger records", () => {
    const base = mkdtempSync(join(tmpdir(), "eden-dump-"));
    dirs.push(base);
    const root = join(base, "memory");
    const mem = openMemory({ dir: root, session: "s1" });
    mem.remember("The build tag for module alpha is tag-alpha.");
    mem.close();
    const waiting = {
      store: "s2",
      row: { id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", text: "The build tag is tag-beta.", t: 5 },
    };
    writeFileSync(join(root, "pending.jsonl"), `${JSON.stringify(waiting)}\n`);
    appendTurn(windowDir(root, "s1")!, { promptId: "p1", prompt: "hello there", off: 0 });

    const { code, out } = dump(root);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      rows: { id: string; text: string; store: string; seq?: number; pending?: boolean }[];
      ledger: { window: string; k: string; prompt_id?: string }[];
    };
    const alpha = parsed.rows.find((row) => row.text.includes("tag-alpha"));
    expect(alpha).toMatchObject({ store: "s1" });
    expect(typeof alpha?.seq).toBe("number");
    expect(parsed.rows.find((row) => row.text.includes("tag-beta"))).toMatchObject({ store: "s2", pending: true });
    expect(parsed.ledger).toContainEqual(expect.objectContaining({ window: "s1", k: "turn", prompt_id: "p1" }));
  });

  test("an empty or missing store dumps as empty lists", () => {
    const base = mkdtempSync(join(tmpdir(), "eden-dump-"));
    dirs.push(base);
    const { code, out } = dump(join(base, "memory"));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ rows: [], ledger: [] });
  });
});
