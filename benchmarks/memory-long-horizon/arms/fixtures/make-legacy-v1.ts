#!/usr/bin/env bun
/**
 * Writes `legacy-v1.json`: Eden memory stores in the format `plugins/eden-memory` wrote before P0.5 (one store per
 * Claude session), for the A5 `migrate` arm. It plays six sessions through that plugin, then keeps every file under
 * the memory root, with the planted secrets replaced by `{{SECRET:<shape>}}` placeholders (`{{SECRET_LOWER:…}}`
 * where the store lowercased one), and fails if any 8-character piece of a secret survives. The arm fills in fresh
 * synthetic values, so none is committed). The kinds are A5's:
 * a normal session; two worktrees of one repo; a session with no transcript left; a corrupt last line; 5 secret
 * shapes; a 2 KB paste.
 *
 * It was run once, at commit 17dca7d7c (the plugin before P0.5). Running it against a later plugin writes that
 * plugin's format, which is not the legacy one.
 *
 *   bun benchmarks/memory-long-horizon/arms/fixtures/make-legacy-v1.ts
 */
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { plainCue } from "../../harness/cues";
import { listFiles } from "../../harness/metrics";
import { loadPlugin } from "../../harness/runner";
import { SimWorld, type SessionPlace } from "../../harness/session";
import { secretCases } from "../secrets";

/**
 * Five shapes the plugin stored unredacted in the `secrets` arm's first run (A6 §1, A1-D4), among those its tokenizer
 * keeps whole: a JWT or a webhook URL would be split into postings no placeholder can rebuild.
 */
export const LEGACY_SECRET_SHAPES = ["gitlab-pat", "npm", "google-api", "shopify", "databricks"];

export interface LegacySession {
  id: string;
  /** Where it ran: the main checkout, the worktree, or nowhere a transcript still records. */
  place: "main" | "worktree";
  transcript: boolean;
  kind: string;
}

export interface LegacyFixture {
  about: string;
  sessions: LegacySession[];
  /** Files under the memory root, by relative path. */
  files: Record<string, string>;
}

const PASTE_LINES = Array.from(
  { length: 40 },
  (_, n) => `2026-09-${String((n % 28) + 1).padStart(2, "0")} worker ${n} ok`,
);

/** Every 8-character piece of a secret, lowercased: what must not survive the placeholders. */
function fragments(value: string): string[] {
  const lower = value.toLowerCase();
  return Array.from({ length: Math.max(0, lower.length - 7) }, (_, at) => lower.slice(at, at + 8));
}

async function main(): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), "legacy-v1-"));
  const plugin = loadPlugin(join(import.meta.dir, "../../../../plugins/eden-memory"));
  const world = new SimWorld({ runDir, plugin, seed: 41 });
  const worktree = world.addWorktree(".claude/worktrees/agent-x", "agent-x");
  const secrets = Object.fromEntries(
    secretCases()
      .filter((item) => item.channel === "prompt" && item.position === "middle")
      .filter((item) => LEGACY_SECRET_SHAPES.includes(item.shape))
      .map((item) => [item.shape, item.secret]),
  );
  const sessions: LegacySession[] = [];
  const play = async (kind: string, prompts: string[], place?: SessionPlace) => {
    const session = world.newSession(place);
    await session.start();
    for (const text of prompts) {
      await session.prompt(text, "typed", { cue: plainCue() });
      await session.main.assistant("Noted.");
      await session.stop();
    }
    await session.end();
    sessions.push({ id: session.sessionId, place: place ? "worktree" : "main", transcript: true, kind });
    return session;
  };
  await play("normal", ["The database is postgres.", "Never merge PRs yourself.", "We use Redis for caching."]);
  await play("worktree", ["The auth provider is Clerk."], worktree);
  const orphan = await play("no-transcript", ["The staging server is called orbit."]);
  await play("corrupt-last-line", ["Releases are tagged on Fridays.", "The design files live in Figma."]);
  await play(
    "secrets",
    Object.entries(secrets).map(([shape, value]) => `For staging the ${shape} credential is ${value}, keep it handy.`),
  );
  const paste = `<pasted_content id="p1">\n${PASTE_LINES.join("\n").padEnd(2048, ".")}\n</pasted_content id="p1">`;
  await play("paste", [`here is the worker log:\n${paste}\nwhy is worker 7 slow?`]);

  rmSync(orphan.transcriptPath);
  sessions.find((session) => session.id === orphan.sessionId)!.transcript = false;
  const memory = join(world.home, ".eden", "memory");
  const corrupt = sessions.find((session) => session.kind === "corrupt-last-line")!;
  const rows = join(memory, corrupt.id, "memories.jsonl");
  truncateSync(rows, readFileSync(rows).length - 12);

  const files: Record<string, string> = {};
  for (const path of listFiles(memory)) {
    let text = readFileSync(path, "utf8");
    for (const [shape, value] of Object.entries(secrets)) {
      text = text.replaceAll(value, `{{SECRET:${shape}}}`).replaceAll(value.toLowerCase(), `{{SECRET_LOWER:${shape}}}`);
    }
    if (text.includes(runDir)) throw new Error(`${path} names the run directory`);
    const left = Object.values(secrets).find((value) =>
      fragments(value).some((part) => text.toLowerCase().includes(part)),
    );
    if (left) throw new Error(`${path} still holds part of a planted secret`);
    files[relative(memory, path)] = text;
  }
  const fixture: LegacyFixture = {
    about:
      "Pre-P0.5 Eden memory stores for the A5 migrate arm, written by make-legacy-v1.ts through plugins/eden-memory " +
      "at 17dca7d7c. Secrets are {{SECRET:<shape>}} placeholders.",
    sessions,
    files,
  };
  writeFileSync(join(import.meta.dir, "legacy-v1.json"), JSON.stringify(fixture, null, 2) + "\n");
  rmSync(runDir, { recursive: true, force: true });
  console.log(`${sessions.length} sessions, ${Object.keys(files).length} files`);
}

if (import.meta.main) await main();
