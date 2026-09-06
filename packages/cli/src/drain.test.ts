import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "./home";
import { drain, lastOutboxKind, projectLiveTools, stretchEndForRun } from "./drain";
import { LISTING_WITHHELD_BANNER, listingDraftPath, renderSkill, skillHashLogPath, skillPaths } from "./manifest";
import { compileTraces } from "../../compile/src/compile";
import type { StretchTrace } from "@eden/ir";

describe("drain outbox", () => {
  test("stretch_end only when Stop was last for that run", () => {
    const box = [
      JSON.stringify({ run_id: "a", kind: "turn_split", ts: 1 }),
      JSON.stringify({ run_id: "a", kind: "stretch_end", ts: 2 }),
      JSON.stringify({ run_id: "b", kind: "turn_split", ts: 3 }),
    ].join("\n");
    expect(lastOutboxKind(box, "a")).toBe("stretch_end");
    expect(stretchEndForRun(box, "a")).toBe(true);
    expect(stretchEndForRun(box, "b")).toBe(false);
    expect(stretchEndForRun(box, "missing")).toBe(false);
  });
});

describe("drain actually drains", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedKey: string | undefined;
  let savedBase: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ingested: Array<{ run_id: string; stretch_end?: boolean; events: unknown[] }>;

  beforeEach(() => {
    savedHome = process.env.EDEN_HOME;
    savedKey = process.env.EDEN_API_KEY;
    savedBase = process.env.EDEN_BASE_URL;
    home = mkdtempSync(join(tmpdir(), "eden-drain-"));
    process.env.EDEN_HOME = home;
    process.env.EDEN_API_KEY = "eden_test";
    mkdirSync(join(home, "runs"), { recursive: true });
    ingested = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    for (const [k, v] of [
      ["EDEN_HOME", savedHome],
      ["EDEN_API_KEY", savedKey],
      ["EDEN_BASE_URL", savedBase],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function serveSite(): void {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/v1/ingest") {
          ingested.push((await req.json()) as (typeof ingested)[number]);
          return Response.json({ ok: true });
        }
        if (u.pathname === "/v1/tools") return new Response("no", { status: 404 });
        return Response.json({ tools: [] });
      },
    });
    process.env.EDEN_BASE_URL = `http://127.0.0.1:${server.port}`;
  }

  function outbox(): string {
    const p = join(home, "outbox.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  test("a drained run is removed from the outbox instead of being re-sent forever", async () => {
    serveSite();
    const events = join(home, "runs", "r1.jsonl");
    appendJsonl(events, { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(events, { id: "e2", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r1", kind: "stretch_end", ts: Date.now() });

    await drain();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.stretch_end).toBe(true);
    expect(outbox()).not.toContain("r1");

    await drain();
    expect(ingested).toHaveLength(1);
  });

  test("an event written during the upload is not destroyed", async () => {
    const events = join(home, "runs", "r2.jsonl");
    let late = false;
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/v1/ingest") {
          await req.json();
          if (!late) {
            late = true;
            appendJsonl(events, { id: "late", name: "Bash", args: {}, ok: true });
          }
          return Response.json({ ok: true });
        }
        if (u.pathname === "/v1/tools") return new Response("no", { status: 404 });
        return Response.json({ tools: [] });
      },
    });
    process.env.EDEN_BASE_URL = `http://127.0.0.1:${server.port}`;

    appendJsonl(events, { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(events, { id: "e2", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r2", kind: "stretch_end", ts: Date.now() });

    await drain();
    expect(existsSync(events)).toBe(true);
    expect(readFileSync(events, "utf8")).toContain("late");
  });

  test("an unreachable site leaves everything for the next attempt", async () => {
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    const events = join(home, "runs", "r3.jsonl");
    appendJsonl(events, { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r3", kind: "stretch_end", ts: Date.now() });

    await drain();
    expect(readFileSync(events, "utf8")).toContain("e1");
    expect(outbox()).toContain("r3");
  });
});

describe("live-tool projection keeps skill fields", () => {
  test("when_to_use, read_only, sequence, and name survive wrap and site shapes", () => {
    const wrap = projectLiveTools([
      {
        id: "t1",
        name: "wrap_name",
        read_only: true,
        program: {
          name: "pr_summary",
          sequence: ["Bash", "Read"],
          description: "Summarize PRs from recorded review/state/files calls",
          contract: { envelope: { inputs: { issue: ["101"] } } },
        },
      },
    ]);
    expect(wrap).toEqual([
      {
        name: "pr_summary",
        sequence: ["Bash", "Read"],
        id: "t1",
        envelope: { inputs: { issue: ["101"] } },
        read_only: true,
        when_to_use: "Summarize PRs from recorded review/state/files calls",
      },
    ]);

    const writes = projectLiveTools([
      {
        id: "t-w",
        transparent_writes: true,
        program: { name: "patch_pr", sequence: ["Read", "Write"], description: "Apply a recorded patch" },
      },
    ]);
    expect(writes[0]).toMatchObject({
      name: "patch_pr",
      sequence: ["Read", "Write"],
      transparent_writes: true,
    });

    const site = projectLiveTools([
      {
        name: "issue_triage",
        when_to_use: "Triage open issues in one call",
        sequence: ["WebFetch", "Bash"],
        read_only: false,
      },
    ]);
    expect(site[0]).toMatchObject({
      name: "issue_triage",
      when_to_use: "Triage open issues in one call",
      sequence: ["WebFetch", "Bash"],
      read_only: false,
    });
  });

  test("canary rollout survives wrap and site shapes so drain cannot promote", () => {
    const wrap = projectLiveTools([
      {
        id: "c1",
        rollout: "canary",
        program: { name: "desk_close", sequence: ["search", "close"] },
      },
    ]);
    expect(wrap[0]).toMatchObject({ id: "c1", name: "desk_close", rollout: "canary" });
    const site = projectLiveTools([{ name: "desk_close", sequence: ["search"], rollout: "live" }]);
    expect(site[0]?.rollout).toBe("live");
    const missing = projectLiveTools([{ name: "old", sequence: ["search"] }]);
    expect(missing[0]?.rollout).toBeUndefined();
  });

  test("island-bearing compile lands the one-liner, not the stretch dump", () => {
    const line =
      "When the next step is a draftReply judgment after lookupTicket → fetchDetails — one call, do not re-run the loop.";
    const dump = "Run the repeating stretch as one tool: lookupTicket → fetchDetails → draftReply → notify.";
    const island = projectLiveTools([
      {
        id: "p1",
        program: {
          name: "lookupTicket_to_notify",
          sequence: ["lookupTicket", "fetchDetails", "draftReply", "notify"],
          description: dump,
          when_to_use: line,
          steps: [{ kind: "island", when_to_use: line }],
        },
      },
    ]);
    expect(island[0]?.when_to_use).toBe(line);
    expect(island[0]?.when_to_use).not.toContain("Run the repeating stretch as one tool");
  });

  test("silent island falls back to description", () => {
    const dump = "Run the repeating stretch as one tool: lookupTicket → draftReply → notify.";
    const blank = projectLiveTools([
      {
        program: {
          name: "silent",
          sequence: ["lookupTicket", "draftReply", "notify"],
          description: dump,
          steps: [{ kind: "island", when_to_use: "  " }],
        },
      },
    ]);
    expect(blank[0]?.when_to_use).toBe(dump);
    const missing = projectLiveTools([
      {
        program: {
          name: "silent",
          sequence: ["lookupTicket", "draftReply", "notify"],
          description: dump,
          steps: [{ kind: "island" }],
        },
      },
    ]);
    expect(missing[0]?.when_to_use).toBe(dump);
  });

  test("compiled island program → SKILL.md body is the island line", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `w${i}`,
      llmCalls: 3,
      duration_ms: 40,
      cost_cents: 1,
      input: { id: `T-${i}` },
      output: { text: "ok" },
      events: [
        { name: "lookupTicket", args: { id: `T-${i}` }, result: { ok: true }, ok: true },
        { name: "fetchDetails", args: { id: `T-${i}` }, result: { body: "x" }, ok: true },
        { name: "draftReply", args: { id: `T-${i}` }, result: { text: "a" }, ok: true },
        { name: "notify", args: { id: `T-${i}` }, result: { ok: true }, ok: true },
      ],
    }));
    const p = compileTraces(traces).programs[0];
    expect(p).toBeTruthy();
    const projected = projectLiveTools([{ program: p }]);
    const line =
      "When the next step is a draftReply judgment after lookupTicket → fetchDetails — one call, do not re-run the loop.";
    expect(projected[0]?.when_to_use).toBe(line);
    const md = renderSkill(projected);
    const body = md.split(`## ${p!.name}`)[1] ?? "";
    expect(body).toContain(line);
    expect(body).not.toContain("Run the repeating stretch as one tool");
    expect(p!.description).toContain("Run the repeating stretch as one tool");
  });
});

describe("drain refreshes opted-in SKILL.md in one cycle", () => {
  let home: string;
  let workspace: string;
  let savedHome: string | undefined;
  let savedKey: string | undefined;
  let savedBase: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let live: unknown[];
  let fetched: string[];

  beforeEach(() => {
    savedHome = process.env.EDEN_HOME;
    savedKey = process.env.EDEN_API_KEY;
    savedBase = process.env.EDEN_BASE_URL;
    home = mkdtempSync(join(tmpdir(), "eden-drain-skill-"));
    workspace = mkdtempSync(join(tmpdir(), "eden-ws-"));
    process.env.EDEN_HOME = home;
    process.env.EDEN_API_KEY = "eden_test";
    mkdirSync(join(home, "runs"), { recursive: true });
    live = [];
    fetched = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    for (const [k, v] of [
      ["EDEN_HOME", savedHome],
      ["EDEN_API_KEY", savedKey],
      ["EDEN_BASE_URL", savedBase],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function serveLive(): void {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        fetched.push(`${u.host}${u.pathname}`);
        if (u.pathname === "/v1/ingest") {
          await req.json();
          return Response.json({ ok: true });
        }
        if (u.pathname === "/v1/tools") return Response.json({ tools: live });
        return Response.json({ tools: live });
      },
    });
    process.env.EDEN_BASE_URL = `http://127.0.0.1:${server.port}`;
  }

  test("Approve/drain updates SKILL.md, listing draft, and content-hash when live tools change", async () => {
    serveLive();
    const paths = skillPaths(workspace);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.skill, "---\nname: eden-routines\ndescription: placeholder\n---\n\nstale\n");
    writeFileSync(paths.toolsMd, "# stale\n");

    live = [
      {
        id: "t1",
        name: "pr_summary",
        when_to_use: "Summarize PRs from recorded review/state/files calls",
        sequence: ["Bash", "Bash"],
        read_only: true,
      },
    ];
    await drain({ workspace });
    const first = readFileSync(paths.skill, "utf8");
    expect(first).toContain("Summarize PRs from recorded review/state/files calls");
    expect(first).toContain("## pr_summary");
    expect(first).not.toContain("stale");
    const hash1 = JSON.parse(readFileSync(skillHashLogPath(), "utf8")) as { path: string; sha256: string; at: string };
    expect(hash1.path).toBe(paths.skill);
    expect(hash1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(listingDraftPath(), "utf8").startsWith(LISTING_WITHHELD_BANNER)).toBe(true);
    expect(existsSync(join(paths.dir, "LISTING.md"))).toBe(false);
    expect(readFileSync(paths.toolsMd, "utf8")).toContain("Summarize PRs from recorded review/state/files calls");
    const cache = JSON.parse(readFileSync(join(home, "live-tools.json"), "utf8")) as Array<{ when_to_use?: string }>;
    expect(cache[0]?.when_to_use).toBe("Summarize PRs from recorded review/state/files calls");

    live = [
      {
        id: "t2",
        name: "issue_triage",
        when_to_use: "Triage open issues in one call",
        sequence: ["WebFetch"],
        read_only: true,
      },
    ];
    await drain({ workspace });
    const second = readFileSync(paths.skill, "utf8");
    expect(second).toContain("Triage open issues in one call");
    expect(second).toContain("## issue_triage");
    expect(second).not.toContain("pr_summary");
    const hash2 = JSON.parse(readFileSync(skillHashLogPath(), "utf8")) as { sha256: string };
    expect(hash2.sha256).not.toBe(hash1.sha256);

    expect(fetched.every((u) => !/skillhub|marketplace|listings/i.test(u))).toBe(true);
    expect(fetched.some((u) => u.includes("/v1/tools") || u.includes("/v1/live-tools"))).toBe(true);
    expect(readFileSync(listingDraftPath(), "utf8")).not.toMatch(/https?:\/\//);
  });

  test("absent SKILL.md and eden.tools.md stay absent (no surprise install)", async () => {
    serveLive();
    live = [{ name: "pr_summary", sequence: ["Bash"], when_to_use: "Summarize PRs" }];
    await drain({ workspace });
    const paths = skillPaths(workspace);
    expect(existsSync(paths.skill)).toBe(false);
    expect(existsSync(listingDraftPath())).toBe(false);
    expect(existsSync(paths.toolsMd)).toBe(false);
    expect(existsSync(skillHashLogPath())).toBe(false);
  });

  test("a down plane leaves an existing SKILL.md untouched", async () => {
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1";
    const paths = skillPaths(workspace);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.skill, "---\nname: eden-routines\ndescription: keep me\n---\n\nuntouched\n");
    appendJsonl(join(home, "runs", "r-down.jsonl"), { id: "e1", name: "Bash", args: {}, ok: true });
    appendJsonl(join(home, "outbox.jsonl"), { run_id: "r-down", kind: "stretch_end", ts: Date.now() });
    await drain({ workspace });
    expect(readFileSync(paths.skill, "utf8")).toContain("untouched");
    expect(existsSync(listingDraftPath())).toBe(false);
    expect(existsSync(join(paths.dir, "LISTING.md"))).toBe(false);
    expect(readFileSync(join(home, "runs", "r-down.jsonl"), "utf8")).toContain("e1");
  });

  test("island-bearing wrap program drains the one-liner into SKILL.md", async () => {
    serveLive();
    const paths = skillPaths(workspace);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.skill, "---\nname: eden-routines\ndescription: placeholder\n---\n\nstale\n");
    const line =
      "When the next step is a draftReply judgment after lookupTicket → fetchDetails — one call, do not re-run the loop.";
    live = [
      {
        id: "p-isle",
        program: {
          name: "lookupTicket_to_notify",
          sequence: ["lookupTicket", "fetchDetails", "draftReply", "notify"],
          description: "Run the repeating stretch as one tool: lookupTicket → fetchDetails → draftReply → notify.",
          when_to_use: line,
          steps: [{ kind: "island", when_to_use: line }],
        },
      },
    ];
    await drain({ workspace });
    const md = readFileSync(paths.skill, "utf8");
    expect(md).toContain(line);
    expect(md).not.toContain("Run the repeating stretch as one tool");
    const cache = JSON.parse(readFileSync(join(home, "live-tools.json"), "utf8")) as Array<{ when_to_use?: string }>;
    expect(cache[0]?.when_to_use).toBe(line);
  });
});
