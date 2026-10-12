/**
 * P2.5 (A4 §5.3, D23): what `PreToolUse(Agent)` records of a launch, and how a SubagentStart, whose payload has no task
 * prompt (R0 F27), finds its own launch's record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childTranscript } from "./memory-session";
import {
  agentClasses,
  claimSpawn,
  recordSpawn,
  spawnOf,
  storedScope,
  storeScope,
  taskPaths,
  type Spawn,
} from "./memory-spawn";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-spawn-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const launch = (id: string, type: string, t: number, paths: string[] = []): Spawn => ({
  id,
  type,
  paths,
  classes: [],
  t,
});

describe("taskPaths: the places of the repo a task names", () => {
  const repo = () => {
    for (const folder of ["apps/web/app", "packages/cli/src", "src", "and"])
      mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# demo\n");
    return dir;
  };

  test("paths with a folder, and the top's files, in the order named", () => {
    const top = repo();
    expect(taskPaths("fix the redirect in apps/web/app/login.ts, then check packages/cli/ and README.md", top)).toEqual(
      ["apps/web/app/login.ts", "packages/cli", "README.md"],
    );
  });

  test("a path is the repo's when it, or its folder, exists there: a file to create counts", () => {
    const top = repo();
    expect(taskPaths("add apps/web/app/new.ts; and/or check docs/guide.md and/or", top)).toEqual([
      "apps/web/app/new.ts",
    ]);
  });

  test("an absolute path inside the repo is made relative to its top; one outside it is no place of the repo", () => {
    const top = repo();
    expect(taskPaths(`read ${join(top, "apps/web/app/x.ts")} and /etc/hosts`, top)).toEqual(["apps/web/app/x.ts"]);
  });

  test("URLs, versions, abbreviations and plain words are not paths", () => {
    const top = repo();
    expect(taskPaths("see https://github.com/apps/web, bump to v1.2.3, e.g. the auth flow, or the db", top)).toEqual(
      [],
    );
  });

  test("each path once, at most 8", () => {
    const top = repo();
    const named = Array.from({ length: 12 }, (_, n) => `src/f${n}.ts`);
    expect(taskPaths([...named, "src/f0.ts"].join(" "), top)).toEqual(named.slice(0, 8));
  });
});

describe("spawnOf: a PreToolUse(Agent) payload's launch record", () => {
  const payload = (input: Record<string, unknown>) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_1",
    tool_input: input,
  });

  test("its id, type, paths and the classes its task names; never its text (X11)", () => {
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    const prompt = "merge the dependabot PR in apps/web once CI is green";
    const spawn = spawnOf(payload({ prompt }), dir, 1_000);
    expect(spawn).toMatchObject({ id: "toolu_1", type: "general-purpose", paths: ["apps/web"], t: 1_000 });
    expect(spawn?.classes).toContain("integrate");
    expect(JSON.stringify(spawn)).not.toContain("dependabot");
  });

  test("the type the call names", () => {
    expect(spawnOf(payload({ prompt: "look at src/a.ts", subagent_type: "Explore" }), dir, 1)?.type).toBe("Explore");
  });

  test("no record for another tool, or a call with no id", () => {
    expect(spawnOf({ ...payload({ prompt: "x" }), tool_name: "Bash" }, dir, 1)).toBeUndefined();
    expect(spawnOf({ ...payload({ prompt: "x" }), tool_use_id: undefined }, dir, 1)).toBeUndefined();
  });
});

describe("claimSpawn: a SubagentStart takes its launch's record, once (A4 §5.3)", () => {
  test("the one unconsumed record of its type within 5 s, once", () => {
    recordSpawn(dir, launch("toolu_a", "Explore", 1_000));
    recordSpawn(dir, launch("toolu_g", "general-purpose", 1_500));
    expect(claimSpawn(dir, { type: "Explore", now: 3_000, agent: "a1" })?.id).toBe("toolu_a");
    expect(claimSpawn(dir, { type: "Explore", now: 3_000, agent: "a2" })).toBeUndefined();
    recordSpawn(dir, launch("toolu_b", "Explore", 3_500));
    expect(claimSpawn(dir, { type: "Explore", now: 4_000, agent: "a3" })?.id).toBe("toolu_b");
  });

  test("two unconsumed records of its type within 5 s: which is whose cannot be told, so none is taken", () => {
    recordSpawn(dir, launch("toolu_a", "Explore", 1_000));
    recordSpawn(dir, launch("toolu_b", "Explore", 2_000));
    expect(claimSpawn(dir, { type: "Explore", now: 3_000, agent: "a1" })).toBeUndefined();
    expect(claimSpawn(dir, { type: "Explore", now: 3_000, agent: "a2" })).toBeUndefined();
  });

  test("a record older than 5 s is not taken by type", () => {
    recordSpawn(dir, launch("toolu_a", "Explore", 1_000));
    expect(claimSpawn(dir, { type: "Explore", now: 6_001, agent: "a1" })).toBeUndefined();
  });

  test("a read-only claim consumes nothing", () => {
    recordSpawn(dir, launch("toolu_a", "Explore", 1_000));
    expect(claimSpawn(dir, { type: "Explore", now: 1_500, agent: "a1", mark: false })?.id).toBe("toolu_a");
    expect(claimSpawn(dir, { type: "Explore", now: 1_500, agent: "a2" })?.id).toBe("toolu_a");
  });

  test("a torn or missing log claims nothing", () => {
    expect(claimSpawn(dir, { type: "Explore", now: 1, agent: "a1" })).toBeUndefined();
    writeFileSync(join(dir, "spawn.log"), '{"k":"spawn","id":\n');
    expect(claimSpawn(dir, { type: "Explore", now: 1, agent: "a1" })).toBeUndefined();
  });
});

describe("a child window's stored scope (a resumed subagent reuses it)", () => {
  test("round trip, and none before it is stored", () => {
    expect(storedScope(dir)).toBeUndefined();
    storeScope(dir, { paths: ["apps/web"], classes: ["integrate"], from: "task" });
    expect(storedScope(dir)).toEqual({ paths: ["apps/web"], classes: ["integrate"], from: "task" });
  });
});

describe("agentClasses: the classes an agent type's name fits (A4 §5.3)", () => {
  test("a reviewer gets the review and merge classes", () => {
    expect(agentClasses("code-reviewer")).toEqual(["review", "integrate"]);
    expect(agentClasses("my-plugin:pr-reviewer")).toEqual(["review", "integrate"]);
  });

  test("the built-in types and a fork name no class", () => {
    for (const type of ["general-purpose", "Explore", "Plan", "fork", "statusline-setup", ""])
      expect(agentClasses(type)).toEqual([]);
  });
});

describe("a subagent's own transcript (D25: a child's distance is measured on it)", () => {
  test("agent_transcript_path when the payload names it, else beside the session's transcript", () => {
    const main = join(dir, "s1.jsonl");
    expect(childTranscript({ transcript_path: main, agent_id: "a1", agent_transcript_path: "/x/y.jsonl" })).toBe(
      "/x/y.jsonl",
    );
    expect(childTranscript({ transcript_path: main, agent_id: "a1" })).toBe(
      join(dir, "s1", "subagents", "agent-a1.jsonl"),
    );
    expect(childTranscript({ transcript_path: main, agent_id: "agent-a1" })).toBe(
      join(dir, "s1", "subagents", "agent-a1.jsonl"),
    );
    expect(childTranscript({ agent_id: "a1" })).toBe("");
  });
});
