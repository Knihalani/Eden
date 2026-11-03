/**
 * Strict flags for the lab's $0 CLIs (funnel.ts, hidden-funnel.ts, quality-cli.ts). A misspelled flag used to be
 * ignored: `funnel.ts --presett NEWL` ran the full default ALL3 screen (30 s, exit 0) and read "+0 −0", "the flag
 * does nothing" (audit 2026-11-03b, devloop-lab-accepts-typos-silently). Here an unknown flag, a stray argument or a
 * value flag with no value exits 2 before anything runs, and `--help` (or `-h`) prints the usage and exits 0.
 *
 * Engine settings given as JSON (`--config`, `--set`) go through `labConfig`, i.e. @eden/engine's `checkEngineConfig`
 * with the dependencies the lab wires.
 */
import { checkEngineConfig } from "@eden/engine";

/** Each flag a CLI reads, without its dashes: "value" takes the next argument, "bool" stands alone. */
export type FlagSpec = Record<string, "value" | "bool">;

export type Parsed =
  | { kind: "ok"; values: Map<string, string>; bools: Set<string>; rest: string[] }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * `argv` against `known`. Everything after a bare `--` is returned unread in `rest` (funnel.ts passes it on to
 * hidden-funnel.ts, which checks it). A value flag takes the next argument whatever it is, unless that starts with
 * `--` (a forgotten value). A repeated flag keeps its first value, as the old `indexOf` parsers did.
 */
export function parseFlags(argv: readonly string[], known: FlagSpec): Parsed {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return { kind: "ok", values, bools, rest: argv.slice(i + 1) };
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (!a.startsWith("--")) return { kind: "error", message: `unexpected argument "${a}"` };
    const name = a.slice(2);
    const spec = known[name];
    if (spec === undefined) {
      const near = Object.keys(known).filter((k) => close(k, name));
      return {
        kind: "error",
        message: `unknown flag ${a}` + (near.length ? ` (did you mean ${near.map((k) => `--${k}`).join(", ")}?)` : ""),
      };
    }
    if (spec === "bool") {
      bools.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { kind: "error", message: `${a} needs a value` };
    if (!values.has(name)) values.set(name, value);
    i++;
  }
  return { kind: "ok", values, bools, rest: [] };
}

/** One edit apart, or one is the other with a letter more or less: what a typo looks like. */
function close(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ta = a.slice(i);
  const tb = b.slice(i);
  return ta.slice(1) === tb.slice(1) || ta.slice(1) === tb || ta === tb.slice(1);
}

export interface Flags {
  /** A value flag's value, or `fallback` when it was not given. */
  opt(name: string, fallback: string): string;
  /** Whether a flag (bool or value) was given. */
  has(name: string): boolean;
  /** The arguments after a bare `--`, unread. */
  rest: string[];
}

/**
 * This process's flags against `known`; exits 2 naming the problem (and the usage's first line) on a bad one, or
 * prints `usage` and exits 0 on `--help`. `known` holds every flag the CLI and any helper it hands `argv` to
 * (`labAccess`) read.
 */
export function flags(tool: string, known: FlagSpec, usage: string, argv = process.argv.slice(2)): Flags {
  const parsed = parseFlags(argv, known);
  if (parsed.kind === "help") {
    console.log(usage.trim());
    process.exit(0);
  }
  if (parsed.kind === "error") {
    console.error(`${tool}: ${parsed.message}; --help lists the flags`);
    process.exit(2);
  }
  const { values, bools, rest } = parsed;
  return {
    opt: (name, fallback) => values.get(name) ?? fallback,
    has: (name) => bools.has(name) || values.has(name),
    rest,
  };
}

/**
 * The lab wires every partner dependency a configuration can ask for (cards from `--cards`, the reader from
 * `--reader`); a configuration that needs one the run does not pass is caught by the CLI's own checks (funnel.ts
 * refuses askReader without `--reader`, and says when intent is inert).
 */
export const LAB_DEPS = { cards: true, reader: true } as const;

/**
 * Engine settings for a lab run: `config` (the whole merged configuration, preset and overrides) checked by
 * `checkEngineConfig` with the lab's dependencies and the parent-flag check. Throws naming the key.
 */
export function labConfig(config: unknown, where: string): Record<string, unknown> {
  return checkEngineConfig(config, { where, deps: LAB_DEPS }) as Record<string, unknown>;
}

/** `text` parsed as JSON, or an error naming `where` (a `--set '{probes:true}'` typo is not a stack trace). */
export function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON (${(error as Error).message})`);
  }
}
