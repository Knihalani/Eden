import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Docs name commands (D2016): a doc that tells a session to run `bun run funnel --ask` is only right while the
// script and the flag exist — `funnel --ask` did not (weak-points-1111.md R3, drift found), and nothing failed.
// This test reads every `bun …` command the user-facing docs name and checks the script exists; a `--flag` a doc
// passes must be spelled somewhere in the script the command resolves to. Flags are checked by text, not parsing:
// a flag spelled differently in the file than the docs is exactly the drift this test is for.
const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts ?? {};

// DECISIONS.md and its generated pages are a record: their commands are history and are allowed to name scripts
// since deleted. The rest are instructions.
const RECORD = new Set(["DECISIONS.md", "DECISION-INDEX.md", "DEAD-ENDS.md"]);
// `bun`'s own commands and flags: they exist by definition.
const BUILTIN = new Set(["-e", "add", "build", "install", "init", "x", "bunx", "test", "run"]);
const docs = [
  "README.md",
  "CONTRIBUTING.md",
  ...readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md") && !RECORD.has(f))
    .map((f) => `docs/${f}`),
];

interface Ref {
  doc: string;
  cmd: string;
  script?: string;
  file?: string;
  flag?: string;
}

// `bun run <alias>` and `bun <path.ts>` inside backticks, with the first --flag the doc passes, if any.
function commands(doc: string, text: string): Ref[] {
  const out: Ref[] = [];
  for (const m of text.matchAll(/`bun (?:run )?([a-zA-Z0-9:./_-]+)((?:[^`]|``)*?)`/g)) {
    const name = m[1]!;
    if (
      BUILTIN.has(name) ||
      name.startsWith("-") ||
      name.includes(" ") ||
      name.endsWith("/") ||
      name.startsWith("node_modules/")
    )
      continue;
    const rest = m[2] ?? "";
    const flag = /--[a-zA-Z][a-zA-Z0-9-]*/.exec(rest)?.[0];
    if (name.endsWith(".ts")) {
      out.push({ doc, cmd: m[0], file: name, flag });
    } else {
      out.push({ doc, cmd: m[0], script: name, flag });
    }
  }
  return out;
}

/** The .ts file a `bun run <alias>` command ends in, through `bun run`/`bun` script indirection. */
function resolve(script: string): string | undefined {
  let cmd = scripts[script];
  for (let i = 0; cmd && i < 4; i++) {
    const ts = /(?:bun run |bun )?(?:\.\/)?((?:packages|scripts|examples)\/\S+?\.ts)/.exec(cmd)?.[1];
    if (ts) return ts;
    const next = /bun run ([a-zA-Z0-9:-]+)/.exec(cmd)?.[1];
    cmd = next ? scripts[next] : undefined;
  }
  return undefined;
}

const refs = docs.flatMap((doc) => commands(doc, read(doc)));

describe("the commands the docs name exist (D2016)", () => {
  test("the docs name at least a few commands", () => {
    expect(refs.length).toBeGreaterThan(10);
  });
  for (const ref of refs) {
    test(`${ref.cmd} (${ref.doc})`, () => {
      let file = ref.file;
      if (ref.script !== undefined) {
        if (ref.script.includes(":") && !existsSync(join(root, "package.json"))) return;
        if (!(ref.script in scripts) && !existsSync(join(root, `scripts/${ref.script}.ts`))) {
          // An alias may be a shell script (scripts/test.sh style) or a package.json script.
          expect.soft(existsSync(join(root, "scripts", `${ref.script}.sh`))).toBe(true);
          return;
        }
        file = resolve(ref.script);
        if (file === undefined) return; // a script that is not a single .ts entry (test.sh, format.sh)
      }
      expect(file === undefined || existsSync(join(root, file))).toBe(true);
      if (ref.flag && file !== undefined && existsSync(join(root, file))) {
        const seen = read(file);
        if (!seen.includes(ref.flag)) {
          // The flag may be defined in a file the entry imports (a flags.ts); check a same-directory flags file.
          const dir = join(root, file, "..");
          const flags = readdirSync(dir).filter((f) => f.endsWith(".ts"));
          const anywhere = flags.some((f) => readFileSync(join(dir, f), "utf8").includes(ref.flag!));
          expect(anywhere).toBe(true);
        }
      }
    });
  }
});
