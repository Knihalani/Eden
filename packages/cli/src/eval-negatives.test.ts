/**
 * `eden eval build-negatives` (EXECUTION §8, R9 §R5.3): human prompts from Claude transcripts, pastes stripped,
 * secret-bearing prompts dropped, paths and hosts normalized, a canary on every build, labels kept across builds,
 * and a frozen, hashed set. Everything runs in temp directories; nothing here reads ~/.claude or ~/.eden.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNegatives,
  CanaryError,
  draftPath,
  freezeNegatives,
  labelNegatives,
  readFrozenNegatives,
  type BuildOptions,
} from "./eval-negatives";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `eden-negatives-${name}-`));
  dirs.push(dir);
  return dir;
}

const CLI = join(import.meta.dir, "cli.ts");
const typed = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content: text },
  origin: { kind: "human" },
  promptSource: "typed",
  isSidechain: false,
  ...extra,
});
const toolResult = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] },
});
const notification = (text: string) => typed(`<task-notification>${text}</task-notification>`, {
  origin: { kind: "task-notification" },
  promptSource: "system",
});
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: text } });

/** A transcripts root holding one project with the given sessions (main files), and optional subagent files. */
function transcripts(sessions: Record<string, object[]>, subagents: Record<string, object[]> = {}): string {
  const root = temp("projects");
  const project = join(root, "-Users-alice-Downloads-app");
  mkdirSync(project, { recursive: true });
  for (const [id, lines] of Object.entries(sessions)) {
    writeFileSync(join(project, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  for (const [id, lines] of Object.entries(subagents)) {
    mkdirSync(join(project, id, "subagents"), { recursive: true });
    const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    writeFileSync(join(project, id, "subagents", "agent-a1.jsonl"), body);
  }
  return root;
}

function options(root: string, extra: Partial<BuildOptions> = {}): BuildOptions {
  return { transcripts: root, evalDir: join(temp("eval"), "eval"), home: "/Users/alice", hostnames: ["alice-mbp.local"], ...extra };
}

type Row = { id: string; text: string; label: string | null };
const draft = (evalDir: string): Row[] =>
  readFileSync(draftPath(evalDir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

const ghp = () => "gh" + "p_" + "Zx9Kq2Lm4Np6Rs8Tu0Vw1Xy3Ab5Cd7Ef9Gh2J";

describe("build: which prompts become candidates", () => {
  test("only the human prompts of main transcripts, in order", () => {
    const root = transcripts(
      {
        s1: [
          typed("why does the login page flash?"),
          assistant("Looking."),
          toolResult("ok"),
          notification("agent done"),
          typed("<command-name>/next</command-name>"),
          typed("and the signup page?", { promptSource: "queued" }),
          typed("This session is being continued…", { isCompactSummary: true }),
        ],
      },
      { s1: [typed("Explore the repository and report", { isSidechain: true })] },
    );
    const opts = options(root);
    const report = buildNegatives(opts);
    expect(draft(opts.evalDir).map((row) => row.text)).toEqual(["why does the login page flash?", "and the signup page?"]);
    expect(report).toMatchObject({ prompts: 2, added: 2, total: 2, labelled: 0 });
  });

  test("pastes are stripped, including 200+ characters seen in one of the last 10 tool results", () => {
    const long = "E".repeat(150) + " stack frame " + "F".repeat(100) + ".";
    const root = transcripts({
      s1: [
        toolResult(`$ bun test\n${long}\n`),
        typed(`what does this mean?\n\n${long}`),
        typed('fix it.\n<pasted_content id="p1">\nTypeError: x is undefined\n</pasted_content id="p1">'),
      ],
    });
    const opts = options(root);
    buildNegatives(opts);
    expect(draft(opts.evalDir).map((row) => row.text)).toEqual(["what does this mean?", "fix it."]);
  });

  test("a prompt with a secret, an email or nothing left after stripping is dropped, not redacted", () => {
    const root = transcripts({
      s1: [
        typed(`push with ${ghp()} please`),
        typed('see <pasted_content id="p">\nAPI_KEY=whatever\n</pasted_content id="p">'),
        typed("mail the report to alice@example.com when done."),
        typed("```\nonly code\n```"),
        typed("keep this one."),
      ],
    });
    const opts = options(root);
    const report = buildNegatives(opts);
    expect(draft(opts.evalDir).map((row) => row.text)).toEqual(["keep this one."]);
    expect(report.dropped).toEqual({ secret: 2, email: 1, empty: 1, duplicate: 0 });
  });

  test("home paths and this machine's host names are normalized; repo-relative paths are kept", () => {
    const root = transcripts({
      s1: [typed("open /Users/alice/Downloads/app/src/x.ts and /home/bob/y.ts on ALICE-MBP.local, then apps/web/z.ts.")],
    });
    const opts = options(root);
    buildNegatives(opts);
    expect(draft(opts.evalDir)[0]!.text).toBe(
      "open /Users/USER/Downloads/app/src/x.ts and /home/USER/y.ts on HOST, then apps/web/z.ts.",
    );
  });

  test("identical prompts are one candidate, with an id from their text", () => {
    const root = transcripts({ s1: [typed("continue")], s2: [typed("continue"), typed("  continue  ")] });
    const opts = options(root);
    const report = buildNegatives(opts);
    const rows = draft(opts.evalDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(createHash("sha256").update("continue").digest("hex").slice(0, 16));
    expect(report.dropped.duplicate).toBe(2);
  });
});

describe("build: the canary (EXECUTION §8 step 5)", () => {
  test("every build drops its 5 synthetic secrets, and none reaches the draft", () => {
    const opts = options(transcripts({ s1: [typed("is the cache warm?")] }));
    const report = buildNegatives(opts);
    expect(report.canaries).toEqual({ injected: 5, dropped: 5 });
    expect(draft(opts.evalDir).map((row) => row.text)).toEqual(["is the cache warm?"]);
  });

  test("with the secret filter disabled the build aborts, writes nothing, and names shapes, never values", () => {
    const opts = options(transcripts({ s1: [typed("is the cache warm?")] }), { privateHits: () => [] });
    let error: unknown;
    try {
      buildNegatives(opts);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CanaryError);
    const { message, shapes } = error as CanaryError;
    expect(shapes.sort()).toEqual(["aws-key", "cfat-token", "github-pat", "password-in-prose", "url-userinfo"]);
    expect(message).not.toMatch(/[A-Za-z0-9_]{16,}/);
    expect(existsSync(draftPath(opts.evalDir))).toBe(false);
  });
});

describe("labels and versions", () => {
  test("a rebuild keeps labels, adds new prompts, and keeps rows whose transcripts were swept", () => {
    const root = transcripts({ s1: [typed("first prompt")] });
    const opts = options(root);
    buildNegatives(opts);
    const labelled = draft(opts.evalDir).map((row) => ({ ...row, label: "negative" }));
    writeFileSync(draftPath(opts.evalDir), labelled.map((row) => JSON.stringify(row)).join("\n") + "\n");
    rmSync(join(root, "-Users-alice-Downloads-app", "s1.jsonl"));
    writeFileSync(join(root, "-Users-alice-Downloads-app", "s2.jsonl"), JSON.stringify(typed("second prompt")) + "\n");
    const report = buildNegatives(opts);
    expect(draft(opts.evalDir).map((row) => [row.text, row.label])).toEqual([
      ["first prompt", "negative"],
      ["second prompt", null],
    ]);
    expect(report).toMatchObject({ added: 1, total: 2, labelled: 1 });
  });

  test("labelling reads one answer per line, re-asks on a bad one, saves as it goes, and stops on q", async () => {
    const opts = options(transcripts({ s1: [typed("alpha?"), typed("beta?"), typed("gamma?")] }));
    buildNegatives(opts);
    const shown: string[] = [];
    async function* answers() {
      yield* ["n", "maybe", "p", "q"];
    }
    const result = await labelNegatives(opts.evalDir, answers(), (text) => shown.push(text));
    expect(result).toEqual({ labelled: 2, remaining: 1 });
    expect(draft(opts.evalDir).map((row) => row.label)).toEqual(["negative", "positive", null]);
    expect(shown.join("").split("beta?")).toHaveLength(3);
  });

  test("freeze writes the negatives only, with a sha256 the loader checks; the next freeze is v2", () => {
    const opts = options(transcripts({ s1: [typed("one?"), typed("two?"), typed("three?")] }));
    buildNegatives(opts);
    const labels = ["negative", "positive", "negative"];
    const rows = draft(opts.evalDir).map((row, i) => ({ ...row, label: labels[i] }));
    writeFileSync(draftPath(opts.evalDir), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const first = freezeNegatives(opts.evalDir);
    expect(first).toMatchObject({ version: 1, negatives: 2 });
    expect(first.path.endsWith("real-negatives.v1.jsonl")).toBe(true);
    const bytes = readFileSync(first.path);
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(`${first.path}.sha256`, "utf8")).toBe(`${first.sha256}  real-negatives.v1.jsonl\n`);
    expect(readFrozenNegatives(first.path).map((row) => row.text)).toEqual(["one?", "three?"]);
    expect(freezeNegatives(opts.evalDir)).toMatchObject({ version: 2, negatives: 2 });
    writeFileSync(first.path, bytes.toString("utf8").replace("one?", "One?"));
    expect(() => readFrozenNegatives(first.path)).toThrow("sha256");
  });

  test("freezing with no negative label is refused", () => {
    const opts = options(transcripts({ s1: [typed("unlabelled?")] }));
    buildNegatives(opts);
    expect(() => freezeNegatives(opts.evalDir)).toThrow("no prompt is labelled negative");
  });

  test("the eval directory is 0700 and its files 0600", () => {
    const opts = options(transcripts({ s1: [typed("private?")] }));
    buildNegatives(opts);
    const rows = draft(opts.evalDir).map((row) => ({ ...row, label: "negative" }));
    writeFileSync(draftPath(opts.evalDir), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const frozen = freezeNegatives(opts.evalDir);
    expect(statSync(opts.evalDir).mode & 0o777).toBe(0o700);
    for (const path of [frozen.path, `${frozen.path}.sha256`]) expect(statSync(path).mode & 0o777).toBe(0o600);
    buildNegatives(opts);
    expect(statSync(draftPath(opts.evalDir)).mode & 0o777).toBe(0o600);
  });
});

describe("the command", () => {
  const run = (args: string[], home: string) =>
    Bun.spawnSync(["bun", CLI, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, EDEN_HOME: join(home, ".eden") },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("eden eval build-negatives prints counts and the draft's path, never prompt text", () => {
    const root = transcripts({ s1: [typed("a prompt nobody should see in a log")] });
    const home = temp("home");
    const result = run(["eval", "build-negatives", "--transcripts", root], home);
    const out = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(out).toContain("human prompts: 1");
    expect(out).toContain(join(home, ".eden", "eval", "real-negatives.draft.jsonl"));
    expect(out + result.stderr.toString()).not.toContain("nobody should see");
  });

  test("an unknown subcommand prints usage and exits 1", () => {
    const result = run(["eval", "bogus"], temp("home"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("usage: eden eval build-negatives");
  });
});
