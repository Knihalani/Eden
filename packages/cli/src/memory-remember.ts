/**
 * `eden memory remember` (D11's command): statements the user asks Eden to keep, each stored as one row in their own
 * words (`src:user`), in the store of the repo it is said in (D1):
 *
 *   eden memory remember "<text>"
 *   eden memory remember --jsonl -   (stdin: {"text", "kind"?, "cwd"?, "scope"?} per line)   →   {"remembered": N}
 *
 * A row's repo is its `cwd`'s, else this folder's. A statement of a D9 rule is a rule row, keyed like a typed one;
 * `kind` names any other row's kind. Rows keep no scope yet: the scope catalog is P3.1's, so `scope` is read and
 * ignored. A line that is not a JSON object with a non-empty string `text` is skipped and not counted.
 *
 * `--global` (D11) keeps each policy a statement states for all projects, in the user-global store only
 * (`memory-user-global.ts`); a fact or an intent is never user-global, so it is not counted.
 */
import { openMemory, type AgentMemory } from "../../../src/index";
import { memoryNow } from "../../../src/memory-clock";
import { memoryConsent } from "../../../src/memory-consent";
import { ruleRefs, rulesIn } from "../../../src/memory-policy";
import { scrubMemoryText } from "../../../src/memory-scrub";
import { keepForAllProjects } from "../../../src/memory-user-global";
import { storeFor } from "../../../src/memory-repo";
import { memoryRoot } from "./memory-hook";

export interface Statement {
  text: string;
  kind?: string;
  cwd?: string;
}

/** The statements of a JSONL input, in order. */
export function statementsOf(input: string): Statement[] {
  return input.split("\n").flatMap((line) => {
    let row: { text?: unknown; kind?: unknown; cwd?: unknown } = {};
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      return [];
    }
    if (typeof row?.text !== "string" || !row.text.trim()) return [];
    return [
      {
        text: row.text.trim(),
        ...(typeof row.kind === "string" && row.kind ? { kind: row.kind } : {}),
        ...(typeof row.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}),
      },
    ];
  });
}

/** Stores statements, each in its repo's store; the number stored (none unless memory is on). */
export function rememberStatements(statements: readonly Statement[]): number {
  if (memoryConsent() !== "on") return 0;
  const root = memoryRoot();
  const byStore = new Map<string, Statement[]>();
  for (const statement of statements) {
    const store = storeFor(root, statement.cwd ?? process.cwd());
    const said = byStore.get(store) ?? [];
    said.push(statement);
    byStore.set(store, said);
  }
  let remembered = 0;
  for (const [dir, said] of byStore) {
    const mem: AgentMemory = openMemory({ dir, perRepo: true });
    try {
      remembered += mem.rememberTyped(said).length;
    } finally {
      mem.close();
    }
  }
  return remembered;
}

/** `--global`: the policies of the statements, kept for all projects; the number of rules newly kept. */
export function rememberForAllProjects(statements: readonly Statement[]): number {
  if (memoryConsent() !== "on") return 0;
  const rules = statements.flatMap(({ text, cwd }) => {
    const typed = scrubMemoryText(text, { cwd: cwd ?? process.cwd() });
    return ruleRefs(rulesIn(typed).filter((rule) => rule.kind === "policy")).map((rule) => ({ text: typed, rule }));
  });
  return keepForAllProjects(memoryRoot(), rules, memoryNow()).length;
}

export async function memoryRememberCli(args: string[]): Promise<number> {
  const remember = args.includes("--global") ? rememberForAllProjects : rememberStatements;
  if (args.includes("--jsonl") && args.includes("-")) {
    const remembered = remember(statementsOf(await Bun.stdin.text()));
    console.log(JSON.stringify({ remembered }));
    return 0;
  }
  const text = args
    .filter((arg) => !arg.startsWith("-"))
    .join(" ")
    .trim();
  if (!text) {
    console.log(
      'usage: eden memory remember [--global] "<text>" | --jsonl -   (stdin: {"text", "kind"?, "cwd"?} per line)',
    );
    return 0;
  }
  console.log(`remembered: ${remember([{ text }])}`);
  return 0;
}
