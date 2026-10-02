/**
 * P0.0a targets 1 and 2: the simulator's payloads and transcript lines have the shape of real Claude Code.
 * The references are text-free captures (fixtures/): the payloads a probe plugin received in two real
 * sessions of Claude Code 2.1.285, and the keys of each transcript line kind on this machine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import payloadFixture from "./fixtures/payload-keys.claude-2.1.285.json";
import lineFixture from "./fixtures/transcript-keys.claude-2.1.2xx.json";
import type { HookPayload } from "./payloads";
import type { EventRecord, SimWorld } from "./session";
import { canonicalSession, play } from "./shape";
import { probeWorld, readLines, removeTempDirs, type Probe } from "./testkit";
import { toolUseId } from "./rng";
import { bashCall, readCall } from "./tools";

afterAll(removeTempDirs);

type Shape = (typeof payloadFixture.shapes)[keyof typeof payloadFixture.shapes];
const SHAPES = payloadFixture.shapes as Record<string, Shape>;

/** The fixture's shape key: event, main / subagent / internal-agent, and the source or tool. */
function shapeKey(payload: Record<string, unknown>): string {
  const context =
    "agent_id" in payload ? (payload.agent_type === "" ? "internal-agent" : "subagent") : ("main" as const);
  const disc = payload.tool_name ?? payload.source ?? payload.trigger ?? payload.load_reason ?? "";
  return [payload.hook_event_name, context, disc].filter(Boolean).join("|");
}

function shapeOf(payload: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = { keys: Object.keys(payload) };
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value);
  if (object(payload.tool_input)) shape.tool_input = Object.keys(payload.tool_input as object);
  if (object(payload.tool_response)) {
    const response = payload.tool_response as Record<string, unknown>;
    shape.tool_response = Object.keys(response);
    if (object(response.file)) shape["tool_response.file"] = Object.keys(response.file as object);
  }
  const calls = payload.tool_calls as Record<string, unknown>[] | undefined;
  if (calls?.length) {
    shape["tool_calls[]"] = Object.keys(calls[0]!);
    const kinds = calls.map((call) => (typeof call.tool_response === "string" ? "string" : "array"));
    shape["tool_calls[].tool_response"] = [...new Set(kinds)].sort();
  }
  if (object(payload.effort)) shape.effort = Object.keys(payload.effort as object);
  return shape;
}

const REPORT = "The `name` field in `package.json` is `probe-proj`.";

/**
 * The two captured sessions, replayed in the simulator: Read; two Bash calls in one message; a failing
 * Bash call; an Explore subagent that reads package.json; then `--resume` and `/compact`.
 */
async function mirrorCapturedSessions(world: SimWorld): Promise<{ first: EventRecord[]; second: EventRecord[] }> {
  const id = () => toolUseId(world.ids);
  const at = (path: string) => join(world.projectDir, path);
  const session = world.newSession();
  await session.start();
  await session.prompt("Do these steps in order, then reply with the single word done.");
  await session.main.tools([readCall(id(), at("README.md"), "# demo")]);
  await session.main.tools([
    bashCall(id(), "ls", "List files in current directory", "CLAUDE.md\nREADME.md\npackage.json"),
    bashCall(id(), "cat package.json", "Show package.json contents", '{ "name": "demo" }'),
  ]);
  await session.main.tools([bashCall(id(), "false", "Run a command that exits with failure", "", 1)]);
  const spec = {
    agentType: "Explore",
    description: "Report package.json name field",
    task: "Read package.json and report the name field.",
    background: false,
    report: REPORT,
  };
  await session.subagent(spec, async (window) => {
    await window.tools([readCall(id(), at("package.json"), '{ "name": "demo" }')]);
  });
  await session.main.assistant("done");
  await session.stop();
  await session.end();
  const split = world.log.length;
  await session.resume(211);
  await session.compact("manual", "<analysis> The conversation has one user request. </analysis>");
  await session.end();
  return { first: world.log.slice(0, split), second: world.log.slice(split) };
}

describe("payloads match Claude Code 2.1.285 (target 1)", () => {
  let probe: Probe;
  let first: EventRecord[];
  let second: EventRecord[];
  beforeAll(async () => {
    probe = probeWorld({ permissionMode: "bypassPermissions" });
    ({ first, second } = await mirrorCapturedSessions(probe.world));
  });

  test("all 23 captured shapes are reproduced, with the same ordered and nested keys", () => {
    const simulated = new Map<string, Record<string, unknown>>();
    for (const record of [...first, ...second]) {
      // The fixture kept each shape's first occurrence, so the comparison does too.
      const key = shapeKey(record.payload);
      if (!simulated.has(key)) simulated.set(key, shapeOf(record.payload));
    }
    expect(Object.keys(SHAPES)).toHaveLength(23);
    for (const [key, real] of Object.entries(SHAPES)) {
      expect({ key, shape: simulated.get(key) }).toEqual({ key, shape: real });
    }
    // The one shape with no capture: the docs' InstructionsLoaded(compact) reload (see the order test below).
    expect([...simulated.keys()].sort()).toEqual([...Object.keys(SHAPES), "InstructionsLoaded|main|compact"].sort());
  });

  test("the 13 events are all covered", () => {
    const events = new Set([...first, ...second].map((record) => record.event));
    expect(events.size).toBe(13);
  });

  test("the first session fires its events in the captured order", () => {
    expect(first.map((record) => shapeKey(record.payload))).toEqual(payloadFixture.sequences["tool-and-subagent-run"]);
  });

  test("resume then /compact keeps the captured order, with the two documented deviations", () => {
    // Captured: a second InstructionsLoaded(session_start) just before PreCompact, which the simulator does
    // not fire; and no InstructionsLoaded(compact) after PostCompact, which it fires from the docs (the
    // capture's process ended right after compacting). Both are recorded in the P0.0a report.
    const captured = payloadFixture.sequences["resume-then-compact"];
    const expected = [
      ...captured.slice(0, 2),
      ...captured.slice(3, -1),
      "InstructionsLoaded|main|compact",
      ...captured.slice(-1),
    ];
    expect(captured[2]).toBe("InstructionsLoaded|main|session_start");
    expect(second.map((record) => shapeKey(record.payload))).toEqual(expected);
  });

  test("ids and paths have the captured formats", () => {
    const payloads = [...first, ...second].map((record) => record.payload as HookPayload);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const payload of payloads) {
      expect(String(payload.session_id)).toMatch(uuid);
      if ("prompt_id" in payload) expect(String(payload.prompt_id)).toMatch(uuid);
      if ("tool_use_id" in payload) expect(String(payload.tool_use_id)).toMatch(/^toolu_01[A-Za-z0-9]{22}$/);
      if ("agent_id" in payload) expect(String(payload.agent_id)).toMatch(/^a[0-9a-f]{16}$/);
      const slug = probe.world.projectDir.replace(/[^A-Za-z0-9]/g, "-");
      const projects = join(probe.world.home, ".claude", "projects", slug);
      expect(payload.transcript_path).toBe(join(projects, `${payload.session_id}.jsonl`));
      if ("agent_transcript_path" in payload && payload.agent_type !== "") {
        const child = join(projects, String(payload.session_id), "subagents", `agent-${payload.agent_id}.jsonl`);
        expect(payload.agent_transcript_path).toBe(child);
      }
    }
  });

  test("prompt_id is absent before the process's first prompt, and SubagentStart carries no task prompt", () => {
    const keys = (index: number) => Object.keys(first[index]!.payload);
    expect(keys(0)).not.toContain("prompt_id");
    expect(keys(1)).not.toContain("prompt_id");
    const resume = second.find((record) => record.payload.source === "resume")!;
    expect(Object.keys(resume.payload)).not.toContain("prompt_id");
    const start = first.find((record) => record.event === "SubagentStart")!;
    expect(Object.keys(start.payload)).toEqual(SHAPES["SubagentStart|subagent"]!.keys);
  });

  test("each hook process read its payload byte for byte on stdin", () => {
    const sent = new Set([...first, ...second].map((record) => JSON.stringify(record.payload)));
    const recorded = probe.recorded();
    expect(recorded).toHaveLength(first.length + second.length);
    for (const entry of recorded) expect(sent.has(entry.raw)).toBe(true);
  });

  test("PostToolBatch hands each call's serialized result, a failed Bash call its error string", () => {
    const batches = first.filter((record) => record.event === "PostToolBatch" && record.window === "main");
    const results = batches.flatMap((record) => record.payload.tool_calls as { tool_response: unknown }[]);
    expect(results.slice(0, 4).map((call) => call.tool_response)).toEqual([
      "1\t# demo",
      "CLAUDE.md\nREADME.md\npackage.json",
      '{ "name": "demo" }',
      "Exit code 1",
    ]);
    const handBack = results[4]!.tool_response as { type: string; text: string }[];
    expect(handBack[0]!.text.startsWith("[Subagent hand-back]")).toBe(true);
  });
});

type LineKind = keyof typeof lineFixture.kinds;
type KindKeys = { all_keys: string[]; nested: Record<string, string[]> };

/**
 * No real hook injected context into a subagent on this machine, so that kind has no capture. Its keys are
 * taken from the main thread's attachment plus `agentId`, which every subagent line carries.
 */
const SIDECHAIN_CONTEXT = "sidechain/attachment/hook_additional_context";

function reference(kind: string): KindKeys | undefined {
  if (kind === SIDECHAIN_CONTEXT) {
    const main = lineFixture.kinds["attachment/hook_additional_context"];
    return { all_keys: [...main.all_keys, "agentId"], nested: main.nested };
  }
  return (lineFixture.kinds as Record<string, KindKeys>)[kind];
}

/** The fixture's line kinds, decided the way the fixture was extracted. */
function lineKind(line: Record<string, unknown>, sidechain: boolean): string | undefined {
  const message = (line.message ?? {}) as Record<string, unknown>;
  const content = message.content;
  const first = Array.isArray(content) ? (content[0] as Record<string, unknown> | undefined) : undefined;
  const pre = sidechain ? "sidechain/" : "";
  let kind: string | undefined;
  if (line.type === "user") {
    const origin = (line.origin as { kind?: string } | undefined)?.kind;
    if (line.isCompactSummary) kind = "user/compact-summary";
    else if (first?.type === "tool_result") kind = "user/tool-result";
    else if (sidechain && line.parentUuid === null) kind = "user/task-prompt";
    else if (origin === "human") kind = line.promptSource === "queued" ? "user/queued" : "user/typed";
    else if (origin === "task-notification" || origin === "peer") kind = `user/${origin}`;
  } else if (line.type === "assistant" && (first?.type === "text" || first?.type === "tool_use")) {
    kind = `assistant/${first.type}`;
  } else if (line.type === "attachment") {
    const type = (line.attachment as { type?: string }).type;
    if (type === "hook_additional_context" || type === "queued_command") kind = `attachment/${type}`;
  } else if (line.type === "system" && line.subtype === "compact_boundary") {
    return "system/compact_boundary";
  }
  return kind === undefined ? undefined : pre + kind;
}

/** Keys an encoder reads (A4 §3.3, R6 §1.1): every line kind that has them must carry them. */
const REQUIRED: Record<string, string[]> = {
  "*": ["parentUuid", "isSidechain", "type", "uuid", "timestamp", "cwd", "sessionId", "version", "gitBranch"],
  user: ["promptId", "message"],
  prompt: ["origin", "promptSource", "permissionMode"],
  "tool-result": ["toolUseResult", "sourceToolAssistantUUID"],
  assistant: ["message"],
  attachment: ["attachment"],
  sidechain: ["agentId"],
  compact_boundary: ["logicalParentUuid", "subtype", "compactMetadata"],
  "compact-summary": ["isCompactSummary"],
};

function requiredKeys(kind: string): string[] {
  const parts = kind.split("/");
  const keys = [...REQUIRED["*"]!];
  if (parts.includes("sidechain")) keys.push(...REQUIRED.sidechain!);
  if (parts.includes("user") && !parts.includes("compact-summary")) keys.push(...REQUIRED.user!);
  if (["typed", "queued", "task-notification", "peer"].some((part) => parts.includes(part))) {
    keys.push(...REQUIRED.prompt!);
  }
  for (const part of ["tool-result", "assistant", "attachment", "compact_boundary", "compact-summary"]) {
    if (parts.includes(part)) keys.push(...REQUIRED[part]!);
  }
  if (parts.includes("compact-summary")) keys.push("message");
  return keys;
}

function transcriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("transcript lines match real line kinds (target 2)", () => {
  const seen = new Map<string, Record<string, unknown>[]>();
  let files: string[] = [];
  beforeAll(async () => {
    const probe = probeWorld({ mode: "context" });
    await play(canonicalSession(), probe.world);
    files = transcriptFiles(join(probe.world.home, ".claude", "projects"));
    for (const file of files) {
      for (const line of readLines(file)) {
        const kind = lineKind(line, file.includes("/subagents/"));
        if (kind) seen.set(kind, [...(seen.get(kind) ?? []), line]);
      }
    }
  });

  test("all 15 kinds are written, and nothing else but subagent hook contexts", () => {
    const kinds = Object.keys(lineFixture.kinds) as LineKind[];
    expect(kinds).toHaveLength(15);
    expect([...seen.keys()].sort()).toEqual([...kinds, SIDECHAIN_CONTEXT].sort());
  });

  test("every key written exists on that real kind, and the keys an encoder reads are present", () => {
    for (const [kind, lines] of seen) {
      const real = reference(kind)!;
      const nested = real.nested;
      for (const line of lines) {
        for (const key of Object.keys(line))
          expect({ kind, key, real: real.all_keys.includes(key) }).toEqual({
            kind,
            key,
            real: true,
          });
        for (const [field, keys] of Object.entries(nested)) {
          const value = line[field];
          if (!value || typeof value !== "object") continue;
          for (const key of Object.keys(value))
            expect({ kind, field, key, real: keys.includes(key) }).toEqual({
              kind,
              field,
              key,
              real: true,
            });
        }
        for (const key of requiredKeys(kind))
          expect({ kind, key, present: key in line }).toEqual({
            kind,
            key,
            present: true,
          });
      }
    }
  });

  test("every parentUuid names an earlier line of the same file; only a file's first line and the boundary have none", () => {
    for (const file of files) {
      const uuids = new Set<string>();
      readLines(file).forEach((line, index) => {
        if (line.parentUuid === null) {
          expect(index === 0 || line.subtype === "compact_boundary").toBe(true);
        } else expect(uuids.has(String(line.parentUuid))).toBe(true);
        uuids.add(String(line.uuid));
      });
    }
  });

  test("subagent transcripts sit under <session>/subagents with a meta file", () => {
    const children = files.filter((file) => file.includes("/subagents/agent-"));
    expect(children).toHaveLength(8);
    for (const child of children) {
      const lines = readLines(child);
      expect(lines.every((line) => line.isSidechain === true && typeof line.agentId === "string")).toBe(true);
      const meta = JSON.parse(readFileSync(child.replace(/\.jsonl$/, ".meta.json"), "utf8")) as object;
      expect(Object.keys(meta)).toEqual(["agentType", "description", "toolUseId", "spawnDepth"]);
    }
  });
});
