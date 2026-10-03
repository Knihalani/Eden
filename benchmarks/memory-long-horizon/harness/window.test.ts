/**
 * The simulated context window: what each window's model sees on the current branch, and the window each
 * delivered context and annotated cue finds. Hooks here are the probe in `context` mode, which answers every
 * context event with `probe saw <Event>`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plainCue } from "./cues";
import type { SimSession } from "./session";
import { probeWorld, removeTempDirs, type Probe } from "./testkit";
import { bashCall, readCall } from "./tools";
import { SimulatedWindow } from "./window";

afterAll(removeTempDirs);

describe("the window on its own", () => {
  test("it keeps lines in order, returns to any line on a rewind, and empties on compaction", () => {
    const window = new SimulatedWindow();
    window.loadInstructions("CLAUDE.md", "# rules");
    window.add("a", "first");
    window.add("b", "");
    window.add("c", "second");
    const before = window.snapshot();
    window.rewindTo("b");
    expect(window.snapshot().text).toBe("# rules\nfirst");
    expect(before.text).toBe("# rules\nfirst\nsecond");
    window.rewindTo(null);
    expect(window.snapshot().entries).toEqual([]);
    window.add("d", "third");
    window.compact();
    window.add("e", "summary");
    expect(window.snapshot().text).toBe("# rules\nsummary");
    expect(() => window.rewindTo("d")).toThrow("never saw line d");
  });

  test("a reloaded instruction file replaces its text", () => {
    const window = new SimulatedWindow();
    window.loadInstructions("CLAUDE.md", "old");
    window.loadInstructions("CLAUDE.md", "new");
    expect(window.snapshot().text).toBe("new");
  });
});

async function started(probe: Probe): Promise<SimSession> {
  const session = probe.world.newSession();
  await session.start();
  return session;
}

const text = (session: SimSession) => session.main.seen.snapshot().text;

describe("what the main window holds", () => {
  test("instruction files, prompts, tool calls and results, contexts and replies, in order", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    const file = join(probe.world.projectDir, "src/a.ts");
    await session.prompt("read a.ts please");
    await session.main.tools([readCall("toolu_01AAAAAAAAAAAAAAAAAAAAAA", file, "export const a = 1;")]);
    await session.main.assistant("a is 1");
    const seen = text(session);
    const claude = readFileSync(join(probe.world.projectDir, "CLAUDE.md"), "utf8");
    const order = [
      claude,
      "probe saw SessionStart",
      "read a.ts please",
      "probe saw UserPromptSubmit",
      `"file_path":"${file}"`,
      "1\texport const a = 1;",
      "probe saw PreToolUse",
      "probe saw PostToolUse",
      "probe saw PostToolBatch",
      "a is 1",
    ].map((part) => seen.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("a rewind drops the abandoned branch, its packets included", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("db is postgres");
    await session.main.assistant("noted postgres");
    await session.prompt("what db do we use");
    await session.main.assistant("postgres, you said");
    await session.rewind(1, "db is sqlite now");
    const seen = text(session);
    expect(seen).toContain("noted postgres");
    expect(seen).not.toContain("what db do we use");
    expect(seen).not.toContain("postgres, you said");
    expect(seen).toContain("db is sqlite now");
    // One Submit packet per prompt still on the branch: the first and the rewound one.
    expect(seen.split("probe saw UserPromptSubmit").length - 1).toBe(2);
  });

  test("compaction keeps the instruction files and the summary, not the conversation", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("a long conversation");
    await session.compact("auto", "Summary: the user works on login.");
    const seen = text(session);
    expect(seen).not.toContain("a long conversation");
    expect(seen).toContain("Summary: the user works on login.");
    expect(seen).toContain("# Project");
    expect(seen.indexOf("Summary:")).toBeLessThan(seen.indexOf("probe saw SessionStart"));
  });

  test("a resumed session keeps its window; /clear starts a new, empty one", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("remember the plan");
    await session.end();
    await session.resume(600);
    expect(text(session)).toContain("remember the plan");
    expect(text(session).split("probe saw SessionStart").length - 1).toBe(2);
    const next = await session.clear();
    expect(text(next)).not.toContain("remember the plan");
    expect(next.main.seen.snapshot().entries.map((entry) => entry.text)).toEqual(["probe saw SessionStart"]);
  });

  test("a subagent has its own window: its task, its work and its packet, none of it in the parent's", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("explore the cli");
    const spec = {
      agentType: "Explore",
      description: "Scan",
      task: "scan packages/cli",
      background: false,
      report: "done",
    };
    const run = await session.subagent(spec, async (window) => {
      await window.tools([bashCall("toolu_01BBBBBBBBBBBBBBBBBBBBBB", "ls packages/cli", "List", "cli.ts")]);
    });
    const child = run!.window.seen.snapshot().text;
    expect(child.startsWith("scan packages/cli\nprobe saw SubagentStart")).toBe(true);
    expect(child).toContain("cli.ts");
    expect(child).not.toContain("# Project");
    expect(text(session)).not.toContain("probe saw SubagentStart");
    expect(text(session)).toContain("done");
  });
});

describe("deliveries and cues find the window as it was", () => {
  test("a Submit packet's window holds its prompt, not the packet; the cue is linked and recorded", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    const cue = { ...plainCue("apps/web"), needs: [] };
    await session.prompt("fix login", "typed", { cue });
    const delivery = probe.world.deliveries.find((candidate) => candidate.event === "UserPromptSubmit")!;
    expect(delivery).toMatchObject({
      content: "probe saw UserPromptSubmit",
      cue: 0,
      submit: "human",
      scope: "apps/web",
    });
    expect(delivery.seen.text).toContain("fix login");
    expect(delivery.seen.text).not.toContain("probe saw UserPromptSubmit");
    expect(probe.world.cues).toHaveLength(1);
    expect(probe.world.cues[0]).toMatchObject({ cue, text: "fix login", seq: delivery.seq, window: "main" });
    expect(probe.world.cues[0]!.seen.text).toBe(delivery.seen.text);
  });

  test("non-human submits are marked by who sent them, in the event log and on their packets", async () => {
    const probe = probeWorld({ mode: "context" });
    const session = await started(probe);
    await session.prompt("hello");
    await session.peerMessage("abc", "status?");
    await session.queued("task-notification", "<task-notification>\n<status>completed</status>\n</task-notification>");
    const submits = probe.world.log.filter((record) => record.event === "UserPromptSubmit");
    expect(submits.map((record) => record.submit)).toEqual(["human", "peer", "task-notification"]);
    const kinds = probe.world.deliveries.filter((d) => d.event === "UserPromptSubmit").map((d) => d.submit);
    expect(kinds).toEqual(["human", "peer", "task-notification"]);
  });

  test("a prompt's statement holds from its own Submit; a blocked prompt's never holds", async () => {
    const subjects = [{ key: "db.engine", kind: "slot" as const, words: ["db"], values: { sqlite: ["sqlite"] } }];
    const said = probeWorld({ subjects });
    const session = await started(said);
    await session.prompt("db is sqlite", "typed", { sets: [{ key: "db.engine", scope: "", value: "sqlite" }] });
    const submit = said.world.log.find((record) => record.event === "UserPromptSubmit")!;
    expect(said.world.oracle.truth("db.engine", "", submit.seq - 1)).toBeUndefined();
    expect(said.world.oracle.truth("db.engine", "", submit.seq)?.value).toBe("sqlite");
    const blocked = probeWorld({ subjects, mode: "block" });
    const erased = await started(blocked);
    await erased.prompt("db is sqlite", "typed", { sets: [{ key: "db.engine", scope: "", value: "sqlite" }] });
    expect(blocked.world.oracle.entries).toEqual([]);
  });

  test("a rewind takes back what the abandoned prompts and their queued prompts said", async () => {
    const subjects = [{ key: "db.engine", kind: "slot" as const, words: ["db"], values: { sqlite: ["sqlite"] } }];
    const probe = probeWorld({ subjects });
    const session = await started(probe);
    await session.prompt("start");
    await session.prompt("work on it");
    await session.queued("human", "also, db is sqlite", { sets: [{ key: "db.engine", scope: "", value: "sqlite" }] });
    await session.rewind(1, "work on something else");
    expect(probe.world.oracle.truth("db.engine", "", probe.world.log.length)?.value).toBeNull();
    expect(probe.world.oracle.entries.at(-1)?.cause).toBe("rewind");
  });

  test("a repo change is written, committed and true, and no hook sees it", async () => {
    const subjects = [
      { key: "pkg.manager", kind: "slot" as const, words: ["package manager"], values: { pnpm: ["pnpm"] } },
    ];
    const probe = probeWorld({ subjects });
    await started(probe);
    const events = probe.world.log.length;
    probe.world.changeRepo({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "README.md": null }, [
      { key: "pkg.manager", scope: "", value: "pnpm" },
    ]);
    expect(probe.world.log.length).toBe(events);
    expect(readFileSync(join(probe.world.projectDir, "pnpm-lock.yaml"), "utf8")).toContain("9.0");
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: probe.world.projectDir });
    expect(status.stdout.toString()).toBe("");
    expect(probe.world.oracle.truth("pkg.manager", "apps/web", events)).toEqual({ scope: "", value: "pnpm" });
  });
});
