/**
 * `eden eval build-negatives` (EXECUTION §8, X11; R9 §R5.3): the user's private real-negative set, built from
 * their own Claude transcripts and kept in `~/.eden/eval/`, never in git.
 *
 * A build:
 * 1. selects human prompts (D12's `userTyped`) from each project's main transcripts. Subagent files are skipped, and
 *    so are headless prompts (`claude -p`, `promptSource: "sdk"`): scripts and agents send those, not a person;
 * 2. strips pastes (D12's `stripPastes`, with the last 10 tool results before each prompt);
 * 3. drops, never redacts, a prompt that hits a secret rule (D13, A6 §2.2), a JWT shape or an email address. The
 *    raw prompt is checked, and again what is kept;
 * 4. normalizes home paths to `/Users/USER/` (`/home/USER/`) and this machine's host names to `HOST`; repo-relative
 *    paths stay, since they are cue signal;
 * 5. runs the canary: 5 synthetic secrets, fresh each build, are added to the input as typed transcript lines and go
 *    through the same selection and screening as every prompt. If one is not selected, or any part of one survives,
 *    the build aborts and writes nothing.
 * Candidates are keyed by the sha256 of their text. A rebuild keeps labels, adds new prompts, and keeps rows whose
 * transcripts Claude Code has since swept, so the set grows across builds. `--label` asks for each unlabelled
 * prompt's label; `--freeze` writes the `negative` rows to `real-negatives.vN.jsonl` beside its `.sha256`, which
 * the harness reads through `EDEN_EVAL_NEGATIVES` (`readFrozenNegatives`).
 *
 * The command prints counts and paths. Prompt text is shown only while labelling, in the user's own terminal.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { stripPastes, toolResultText, userTyped } from "../../../src/memory-authority";
import { secretHits } from "../../../src/memory-secrets";
import { edenHome, writeFileAtomic } from "./home";

export type Label = "negative" | "positive" | "drop";

export interface Candidate {
  id: string;
  text: string;
  label: Label | null;
}

export interface FrozenNegative {
  id: string;
  text: string;
}

export interface BuildOptions {
  /** The directory holding one directory per project (Claude Code's `projects/`). */
  transcripts: string;
  evalDir: string;
  /** This machine's host names, replaced by `HOST`. */
  hostnames: string[];
  /** The rules that drop a prompt; a test replaces them to show the canary aborts. */
  privateHits?: (text: string) => string[];
  /** The canaries to add (default: `canaries()`, fresh values); a test passes its own to know their values. */
  canaries?: Canary[];
}

/** One synthetic secret, said in a prompt. */
export interface Canary {
  shape: string;
  secret: string;
  text: string;
}

export type DropReason = "secret" | "email" | "empty" | "duplicate";

export interface BuildReport {
  prompts: number;
  dropped: Record<DropReason, number>;
  canaries: { injected: number; dropped: number };
  added: number;
  total: number;
  labelled: number;
  draft: string;
}

/** A canary was not selected, or survived the screen: the build wrote nothing. Names shapes, never values. */
export class CanaryError extends Error {
  constructor(
    readonly shapes: string[],
    outcome: "survived" | "were not selected",
  ) {
    super(`canary: ${shapes.length} of the synthetic secrets ${outcome} (${shapes.join(", ")})`);
  }
}

/** A human prompt and the tool results the agent had just seen. */
interface SourcePrompt {
  text: string;
  recentToolResults: string[];
}

type Screened = { text: string } | { drop: Exclude<DropReason, "duplicate"> };

const DRAFT = "real-negatives.draft.jsonl";
const FROZEN = /^real-negatives\.v(\d+)\.jsonl$/;
/** A6 §2.1: the tool results a pasted span is looked for in. */
const RECENT_TOOL_RESULTS = 10;
const JWT = /\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LABELS = new Map<string, Label | "skip" | "quit">([
  ["n", "negative"],
  ["p", "positive"],
  ["d", "drop"],
  ["s", "skip"],
  ["q", "quit"],
]);
/** Control characters other than newline and tab, shown escaped so a prompt cannot drive the terminal. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const base62 = (n: number) =>
  [...randomBytes(n)]
    .map((byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[byte % 62])
    .join("");
const base32 = (n: number) => [...randomBytes(n)].map((byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32]).join("");

/** EXECUTION §8 step 5, R9 §R5.3: five shapes, each caught by a different rule. Prefixes are split in the source. */
const CANARY_SHAPES: { shape: string; secret: () => string; prompt: (secret: string) => string }[] = [
  {
    shape: "cfat-token",
    secret: () => "cf" + "at_" + base62(40),
    prompt: (s) => `the deploy job failed with ${s}, why?`,
  },
  { shape: "password-in-prose", secret: () => base62(12), prompt: (s) => `the staging password is ${s} so log in.` },
  {
    shape: "github-pat",
    secret: () => "gh" + "p_" + base62(36),
    prompt: (s) => `push with ${s} if the default fails.`,
  },
  { shape: "aws-key", secret: () => "AK" + "IA" + base32(16), prompt: (s) => `${s} is the deploy user's key.` },
  {
    shape: "url-userinfo",
    secret: () => base62(16),
    prompt: (s) => `the url is postgres://admin:${s}@db.internal:5432/app, is it up?`,
  },
];

/** The 5 canaries, with fresh random values. */
export function canaries(): Canary[] {
  return CANARY_SHAPES.map(({ shape, secret, prompt }) => {
    const value = secret();
    return { shape, secret: value, text: prompt(value) };
  });
}

export const draftPath = (evalDir: string) => join(evalDir, DRAFT);

/** The rules that drop a prompt: every D13 secret rule, a JWT shape, an email address. */
export function privateHits(text: string): string[] {
  return [...secretHits(text), ...(JWT.test(text) ? ["jwt-shape"] : []), ...(EMAIL.test(text) ? ["email"] : [])];
}

function dropReason(hits: readonly string[]): "secret" | "email" | undefined {
  if (hits.some((hit) => hit !== "email")) return "secret";
  return hits.length ? "email" : undefined;
}

/** This machine's host names, longest first: the full name and its first label. */
export function localHostnames(): string[] {
  const full = hostname();
  return [...new Set([full, full.split(".")[0]!])]
    .filter((name) => name.length >= 4)
    .sort((a, b) => b.length - a.length);
}

/** An absolute home directory, not a repo path that happens to hold `home/` (`app/home/page.tsx`). */
const HOME_DIR = /(?<![\w.~-])\/(Users|home)\/[^/\s]+/g;

function normalize(text: string, hostnames: readonly string[]): string {
  let out = text.replace(HOME_DIR, "/$1/USER");
  for (const name of hostnames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "gi"), "HOST");
  }
  return out;
}

function screen(prompt: SourcePrompt, options: BuildOptions): Screened {
  const hits = options.privateHits ?? privateHits;
  const raw = dropReason(hits(prompt.text));
  if (raw) return { drop: raw };
  const text = normalize(stripPastes(prompt.text, prompt.recentToolResults), options.hostnames);
  if (!text) return { drop: "empty" };
  const kept = dropReason(hits(text));
  return kept ? { drop: kept } : { text };
}

/** Every human prompt of the main transcripts under `root`, in file order. */
function readHumanPrompts(root: string): SourcePrompt[] {
  if (!existsSync(root)) return [];
  const projects = readdirSync(root)
    .sort()
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory());
  return projects.flatMap((project) =>
    readdirSync(project)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .flatMap((name) => promptsOf(readFileSync(join(project, name), "utf8").split("\n"))),
  );
}

/** The human prompts of a transcript's lines, each with the tool results before it. */
function promptsOf(lines: readonly string[]): SourcePrompt[] {
  const prompts: SourcePrompt[] = [];
  const recent: string[] = [];
  for (const line of lines) {
    const value = parseLine(line);
    const result = toolResultText(value);
    if (result !== undefined) {
      recent.push(result);
      if (recent.length > RECENT_TOOL_RESULTS) recent.shift();
      continue;
    }
    const text = userTyped(value);
    if (text !== undefined && !headless(value)) prompts.push({ text, recentToolResults: [...recent] });
  }
  return prompts;
}

const headless = (value: unknown) => (value as { promptSource?: unknown }).promptSource === "sdk";

/** A transcript line as Claude Code writes a typed prompt. */
const typedLine = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
  origin: { kind: "human" },
  promptSource: "typed",
});

function parseLine(line: string): unknown {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function readDraft(evalDir: string): Candidate[] {
  const path = draftPath(evalDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Candidate);
}

/** Writes a file of the eval directory: the directory 0700, the file 0600, replaced atomically. */
function writePrivate(evalDir: string, path: string, body: string): void {
  mkdirSync(evalDir, { recursive: true, mode: 0o700 });
  chmodSync(evalDir, 0o700);
  writeFileAtomic(path, body, 0o600);
}

const jsonl = (rows: readonly object[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

/** Steps 1–5: screens every human prompt and merges the new ones into the draft. Throws `CanaryError`. */
export function buildNegatives(options: BuildOptions): BuildReport {
  const injected = options.canaries ?? canaries();
  const planted = promptsOf(injected.map((canary) => JSON.stringify(typedLine(canary.text))));
  const unselected = injected.filter((canary) => !planted.some((prompt) => prompt.text === canary.text));
  if (unselected.length)
    throw new CanaryError(
      unselected.map((canary) => canary.shape),
      "were not selected",
    );
  const prompts = readHumanPrompts(options.transcripts);
  const dropped: Record<DropReason, number> = { secret: 0, email: 0, empty: 0, duplicate: 0 };
  const previous = readDraft(options.evalDir);
  const known = new Set(previous.map((row) => row.id));
  const fresh = new Map<string, Candidate>();
  for (const [n, prompt] of [...planted, ...prompts].entries()) {
    const result = screen(prompt, options);
    // The canaries come first and are never counted: they must not reach `fresh`, which the check below asserts.
    const counted = n >= planted.length;
    if ("drop" in result) {
      if (counted) dropped[result.drop]++;
      continue;
    }
    const id = sha256(result.text).slice(0, 16);
    if (fresh.has(id)) dropped.duplicate += counted ? 1 : 0;
    else if (!known.has(id)) fresh.set(id, { id, text: result.text, label: null });
  }
  const rows = [...previous, ...fresh.values()];
  const surviving = injected.filter((canary) => rows.some((row) => row.text.includes(canary.secret)));
  if (surviving.length)
    throw new CanaryError(
      surviving.map((canary) => canary.shape),
      "survived",
    );
  writePrivate(options.evalDir, draftPath(options.evalDir), jsonl(rows));
  return {
    prompts: prompts.length,
    dropped,
    canaries: { injected: injected.length, dropped: injected.length },
    added: fresh.size,
    total: rows.length,
    labelled: rows.filter((row) => row.label).length,
    draft: draftPath(options.evalDir),
  };
}

const shown = (text: string) =>
  text.replace(CONTROL, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** Step 6: shows each unlabelled prompt and reads its label, one answer per line; saves after each label. */
export async function labelNegatives(
  evalDir: string,
  answers: AsyncIterable<string>,
  show: (text: string) => void,
): Promise<{ labelled: number; remaining: number }> {
  if (!existsSync(draftPath(evalDir))) throw new Error("no draft yet: run eden eval build-negatives first");
  const rows = readDraft(evalDir);
  const todo = rows.filter((row) => !row.label);
  const input = answers[Symbol.asyncIterator]();
  let labelled = 0;
  for (const [n, row] of todo.entries()) {
    let answer: Label | "skip" | "quit" | undefined;
    while (!answer) {
      show(
        `\n[${n + 1}/${todo.length}] ${row.id}\n${shown(row.text)}\nnegative (n) · positive (p) · drop (d) · skip (s) · quit (q): `,
      );
      const next = await input.next();
      answer = next.done ? "quit" : LABELS.get(String(next.value).trim().toLowerCase());
    }
    if (answer === "quit") break;
    if (answer === "skip") continue;
    row.label = answer;
    labelled++;
    writePrivate(evalDir, draftPath(evalDir), jsonl(rows));
  }
  return { labelled, remaining: rows.filter((row) => !row.label).length };
}

/** Step 7: the `negative` rows as the next version, with its sha256 in sha256sum's format. */
export function freezeNegatives(evalDir: string): { version: number; path: string; negatives: number; sha256: string } {
  const negatives = readDraft(evalDir)
    .filter((row) => row.label === "negative")
    .map(({ id, text }): FrozenNegative => ({ id, text }));
  if (!negatives.length) throw new Error("no prompt is labelled negative: run eden eval build-negatives --label");
  const versions = existsSync(evalDir) ? readdirSync(evalDir).map((name) => Number(FROZEN.exec(name)?.[1] ?? 0)) : [];
  const version = Math.max(0, ...versions) + 1;
  const name = `real-negatives.v${version}.jsonl`;
  const path = join(evalDir, name);
  const body = jsonl(negatives);
  const digest = sha256(body);
  writePrivate(evalDir, path, body);
  writePrivate(evalDir, `${path}.sha256`, `${digest}  ${name}\n`);
  return { version, path, negatives: negatives.length, sha256: digest };
}

/** A frozen set and its sha256, after checking its bytes against its `.sha256`; throws when they differ. */
export function readFrozenNegatives(path: string): { sha256: string; negatives: FrozenNegative[] } {
  const body = readFileSync(path);
  const recorded = readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0];
  const actual = sha256(body);
  if (recorded !== actual) {
    throw new Error(`${basename(path)}: its sha256 is ${actual}, but its freeze record says ${recorded}`);
  }
  const negatives = body
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as Partial<FrozenNegative>;
      if (typeof row.id !== "string" || typeof row.text !== "string") throw new Error(`${basename(path)}: bad row`);
      return { id: row.id, text: row.text };
    });
  return { sha256: actual, negatives };
}

export function evalHelp(): string {
  return `usage: eden eval build-negatives [--transcripts DIR]
       eden eval build-negatives --label
       eden eval build-negatives --freeze

Build your private real-negative set (prompts that need no memory) from your own
Claude Code transcripts, in ${join("~", ".eden", "eval")}. Local only; never in git.

  (default)   select human prompts, strip pastes, drop any with a secret or an
              email, normalize paths and hosts; merge into the draft. A canary
              of 5 synthetic secrets runs first; if one survives, nothing is
              written. Prints counts only.
  --label     label each unlabelled prompt: negative (needs no memory),
              positive (needed one) or drop. Resumable.
  --freeze    write the negatives to real-negatives.vN.jsonl and its .sha256.
              The harness reads it from EDEN_EVAL_NEGATIVES=<that path>.
`;
}

function claudeProjects(): string {
  const config = process.env.CLAUDE_CONFIG_DIR;
  return config ? join(config, "projects") : join(homedir(), ".claude", "projects");
}

function nextStep(report: BuildReport): string {
  if (!report.total) return "next: nothing to label yet";
  return `next: eden eval build-negatives ${report.labelled < report.total ? "--label" : "--freeze"}`;
}

function printBuild(report: BuildReport): void {
  console.log(
    [
      `human prompts: ${report.prompts}`,
      `dropped for a secret: ${report.dropped.secret}`,
      `dropped for an email address: ${report.dropped.email}`,
      `dropped with nothing left after stripping pastes: ${report.dropped.empty}`,
      `duplicates: ${report.dropped.duplicate}`,
      `canary: ${report.canaries.dropped} of ${report.canaries.injected} synthetic secrets dropped`,
      `draft: ${report.draft}`,
      `candidates: ${report.total} (${report.added} new, ${report.labelled} labelled)`,
      nextStep(report),
    ].join("\n"),
  );
}

type Mode = { action: "build"; transcripts: string } | { action: "label" } | { action: "freeze" };

/** The mode `build-negatives` was asked for; undefined for an unknown or conflicting flag. */
function parseMode(args: readonly string[]): Mode | undefined {
  const [flag, value, ...extra] = args;
  if (extra.length) return undefined;
  if (flag === undefined) return { action: "build", transcripts: claudeProjects() };
  if (flag === "--transcripts" && value && !value.startsWith("--")) return { action: "build", transcripts: value };
  if (value !== undefined) return undefined;
  if (flag === "--label") return { action: "label" };
  return flag === "--freeze" ? { action: "freeze" } : undefined;
}

export async function evalCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(evalHelp());
    return 0;
  }
  const mode = command === "build-negatives" ? parseMode(rest) : undefined;
  if (!mode) {
    console.error(evalHelp());
    return 1;
  }
  const evalDir = join(edenHome(), "eval");
  try {
    if (mode.action === "label") {
      const show = (text: string) => void process.stdout.write(text);
      const result = await labelNegatives(evalDir, console, show);
      console.log(`\nlabelled ${result.labelled}; ${result.remaining} left`);
    } else if (mode.action === "freeze") {
      const frozen = freezeNegatives(evalDir);
      console.log(`v${frozen.version}: ${frozen.negatives} negatives\n${frozen.path}\nsha256 ${frozen.sha256}`);
      console.log(`use it: EDEN_EVAL_NEGATIVES=${frozen.path}`);
    } else {
      printBuild(buildNegatives({ transcripts: mode.transcripts, evalDir, hostnames: localHostnames() }));
    }
    return 0;
  } catch (error) {
    console.error(`eden eval: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
