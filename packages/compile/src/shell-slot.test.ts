import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StretchProgram, StretchTrace } from "@eden/ir";
import { compileTraces } from "./index";
import { registryFrom, runProgram } from "../../runtime/src/index";

/**
 * Issue #74: second-order shell injection.
 *
 * A compiled Bash step fills its command from an earlier step's result: a
 * fetched record or an island's output. The program does not control that
 * value, so whatever it carries must reach the shell as one literal argument.
 * Every command here runs in a real shell, in an empty workspace.
 */

const PAYLOADS = ["x; touch pwned", "$(touch pwned)", "`touch pwned`", "a' ; touch pwned; echo '"];

/** A fetch (get_ticket) or an island (draft_*) answers `result`; the agent then runs `command`. */
type Source = "get_ticket" | "draft_branch_name";

function trace(id: string, source: Source, result: Record<string, string>, command: string): StretchTrace {
  return {
    id: `${source}-${id}`,
    events: [
      { name: source, args: { id }, result, ok: true },
      { name: "Bash", args: { command: "pwd" }, result: { stdout: "" }, ok: true },
      { name: "Bash", args: { command }, result: { stdout: "" }, ok: true },
      { name: "Bash", args: { command: "ls -a" }, result: { stdout: "" }, ok: true },
    ],
    input: { id },
    output: result,
    llmCalls: 8,
    duration_ms: 8000,
    cost_cents: 8,
    complete: true,
  };
}

/** Three witnesses per value in `values`, each shaped by `shape`. */
function compile(source: Source, values: string[], shape: (v: string) => [Record<string, string>, string]) {
  return compileTraces(values.map((v, i) => trace(`T-${i + 1}`, source, ...shape(v))));
}

function compiled(source: Source): StretchProgram {
  const branches = ["feat-1", "fix-login", "chore-deps"];
  const { programs } = compile(source, branches, (branch) => [{ branch }, `printf %s: ${branch}`]);
  expect(programs.length).toBe(1);
  return programs[0]!;
}

let workspace = "";
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "eden-shell-slot-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Runs `p` with `branch` as the upstream value; Bash runs for real in the workspace. */
async function run(p: StretchProgram, branch: string): Promise<Array<{ command: string; stdout: string }>> {
  const ran: Array<{ command: string; stdout: string }> = [];
  const registry = registryFrom({
    get_ticket: () => ({ branch }),
    Bash: ({ command }) => {
      const r = spawnSync(String(command), { cwd: workspace, shell: true, encoding: "utf8" });
      ran.push({ command: String(command), stdout: r.stdout });
      return { stdout: r.stdout, stderr: r.stderr, code: r.status };
    },
  });
  await runProgram(p, { id: "T-1" }, { registry, island: async () => ({ branch }) });
  return ran;
}

describe("a compiled Bash template fed by an upstream step", () => {
  for (const source of ["get_ticket", "draft_branch_name"] as const) {
    test(`${source}: shell syntax in the value stays one literal argument`, async () => {
      const p = compiled(source);
      const printf = p.steps.find((s) => s.kind === "tool" && s.id.includes("printf"));
      expect(printf).toMatchObject({
        tool: "Bash",
        args: { command: { fn: "template", expr: "printf %s: {branch}", of: { kind: "from", step: source } } },
      });
      if (source === "draft_branch_name") expect(p.steps[0]!.kind).toBe("island");
      for (const payload of PAYLOADS) {
        const ran = await run(p, payload);
        expect(ran.find((r) => r.command.startsWith("printf"))?.stdout).toBe(`${payload}:`);
        expect(readdirSync(workspace)).toEqual([]);
      }
    });
  }

  test("a benign value binds to the same command string as before", async () => {
    for (const source of ["get_ticket", "draft_branch_name"] as const) {
      const ran = await run(compiled(source), "release-2.4_rc1");
      expect(ran.map((r) => r.command)).toEqual(["pwd", "printf %s: release-2.4_rc1", "ls -a"]);
    }
  });

  test("a witness whose value the shell read as syntax is refused, not compiled", () => {
    // `ls -a ~/n1` only worked because the shell expanded the fetched `~`. Replaying
    // that would treat the value as syntax, and quoting it would not be what was witnessed.
    for (const values of [["~/n1", "~/n2", "~/n3"], ["a*", "b*", "c*"]]) {
      const { programs, refusals } = compile("get_ticket", values, (dir) => [{ dir }, `ls -a ${dir}`]);
      expect(programs).toEqual([]);
      expect(refusals.map((r) => r.code)).toEqual(["underdetermined_command"]);
    }
  });

});
