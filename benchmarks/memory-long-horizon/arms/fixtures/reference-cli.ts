#!/usr/bin/env bun
/**
 * The arms' reference product CLI: a minimal, correct implementation of each entry-point contract an arm defines,
 * so the arm's checks are shown to be satisfiable (arms/reference-suite.ts). It answers from the fixtures and from
 * what the run left on disk; it is not Eden and keeps no memory beyond what a contract needs.
 *
 *   memory remember --jsonl -          → {"remembered": N}                         (cuebench.ts, scale.ts)
 *   memory dump --json                 → rows and turn records, from the transcripts (writers.ts)
 *   memory extract --jsonl -           → the E3 gold annotations as records        (extraction.ts)
 *   memory scopes --json <path>…       → R5 §9.3's expected scopes                 (scope-rows.ts)
 *   memory migrate --dry-run --json | --apply | --rollback, EDEN_MIGRATE_CRASH_AFTER   (migrate.ts)
 *   memory aliases --batch FILE --json → {"kept": true}                            (bench.ts)
 *   sleep …                            → exit 0
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { listFiles } from "../../harness/metrics";
import { e3Items, parseGold } from "../extraction";
import { ROWS } from "../scope-rows";

const args = process.argv.slice(2);
const home = process.env.HOME!;
const eden = process.env.EDEN_HOME!;

function stdinLines(): string[] {
  return readFileSync(0, "utf8").split("\n").filter(Boolean);
}

function transcriptLines(): Record<string, unknown>[] {
  return listFiles(join(home, ".claude", "projects"))
    .filter((path) => path.endsWith(".jsonl"))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dump(): unknown {
  const lines = transcriptLines();
  const texts = lines.flatMap((line) => {
    const content = (line.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    return text.includes("The build tag for module") ? [text] : [];
  });
  const rows = texts.map((text, n) => ({ id: `row-${n}`, text }));
  const ledger = lines
    .filter((line) => (line.origin as { kind?: string } | undefined)?.kind === "human")
    .map((line) => ({ window: String(line.sessionId), k: "turn", prompt_id: String(line.promptId) }));
  return { rows, ledger };
}

function extract(): string {
  const items = e3Items();
  return stdinLines()
    .map((line) => {
      const { id, text } = JSON.parse(line) as { id: number; text: string };
      const gold = parseGold(items.find((item) => item.text === text)?.annotations ?? []);
      const records = [
        ...gold.slots.map((alts) => ({ kind: "slot", ...alts[0]! })),
        ...gold.rules.map((rule) => ({ kind: "policy", class: rule.classes[0], polarity: rule.polarity, object: "*" })),
      ];
      return JSON.stringify({ id, records });
    })
    .join("\n");
}

function scopes(paths: string[]): unknown {
  const row = ROWS.find((candidate) => candidate.id === basename(process.cwd()))!;
  const expected = Object.values(row.expect);
  const of = Object.fromEntries(
    paths.map((path) => [path, { repo: "main", scope: row.expect[path] ?? expected[0] ?? "" }]),
  );
  return { scopes: [...new Set(["", ...expected])], of };
}

/** The five legacy secret shapes (fixtures/make-legacy-v1.ts), by prefix: what this migration redacts. */
const LEGACY_SECRET = /\b(?:glpat-|npm_|AIza|shpat_|dapi)[A-Za-z0-9_-]{8,}/gi;
const STEPS = ["backup", "stage", "swap"];

function migrate(flag: string): unknown {
  const memory = join(eden, "memory");
  const legacy = join(eden, "memory.legacy-v1");
  const map = JSON.parse(readFileSync(join(eden, "migrate", "session-map.json"), "utf8")) as Record<string, string>;
  if (flag === "--dry-run") {
    const sessions = Object.keys(map).map((session) => ({ session, repo: "repo-1" }));
    return { steps: STEPS, sessions, unmappable: [] };
  }
  if (flag === "--rollback") {
    if (existsSync(legacy)) {
      rmSync(memory, { recursive: true, force: true });
      renameSync(legacy, memory);
    }
    return { rolledBack: true };
  }
  if (existsSync(legacy)) return { applied: false };
  const crash = (step: string) => {
    if (process.env.EDEN_MIGRATE_CRASH_AFTER === step) process.exit(137);
  };
  writeFileSync(join(eden, "backup.tar"), JSON.stringify(listFiles(memory).map((path) => relative(memory, path))));
  crash("backup");
  const staging = join(eden, "memory.staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "repos", "repo-1"), { recursive: true });
  const episodes = listFiles(memory)
    .filter((path) => path.endsWith("memories.jsonl"))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").filter(Boolean))
    .map((line) => line.replace(LEGACY_SECRET, "[REDACTED]"));
  writeFileSync(join(staging, "repos", "repo-1", "episodes.jsonl"), episodes.join("\n") + "\n");
  crash("stage");
  renameSync(memory, legacy);
  renameSync(staging, memory);
  crash("swap");
  return { applied: true };
}

function main(): number {
  const [command, sub, ...rest] = args;
  if (command === "sleep") return 0;
  if (command !== "memory") return 1;
  if (sub === "remember") console.log(JSON.stringify({ remembered: stdinLines().length }));
  else if (sub === "dump") console.log(JSON.stringify(dump()));
  else if (sub === "extract") console.log(extract());
  else if (sub === "scopes") console.log(JSON.stringify(scopes(rest.filter((arg) => !arg.startsWith("--")))));
  else if (sub === "migrate")
    console.log(JSON.stringify(migrate(rest.find((arg) => arg.startsWith("--") && arg !== "--json")!)));
  else if (sub === "aliases") console.log(JSON.stringify({ kept: true }));
  else return 1;
  return 0;
}

process.exit(main());
