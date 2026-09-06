import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hintIdOf } from "@eden/wrap";
import { resolve } from "node:path";
import { armRemainder, armRemainderFromBatch, claimRemainder, parseToolCalls, ARM_SLACK_CALLS, appendLedgerRow, hostDropReason, ledgerPath, remainderPath, remainderHintOf, joinAgainstCwd } from "./remainder";

const pr = {
  name: "pr_summary",
  sequence: ["Read", "Grep", "Bash"],
  id: "t1",
};

function isolate(): { home: string; restore: () => void } {
  const prevHome = process.env.EDEN_HOME;
  const prevArm = process.env.EDEN_ARM_MAX;
  const home = join(import.meta.dir, `../../.tmp-eden-remainder-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(join(home, "runs"), { recursive: true });
  process.env.EDEN_HOME = home;
  return {
    home,
    restore: () => {
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevArm === undefined) delete process.env.EDEN_ARM_MAX;
      else process.env.EDEN_ARM_MAX = prevArm;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("remainder store (S1b / skipRest on the hook path)", () => {
  test("3-call loop: 1 real + 2 denies (rest counts on sequence[1..])", async () => {
    const { restore } = isolate();
    try {
      const armed = await armRemainder("s1", pr, { id: "E-1" });
      expect(armed).toBe(true);
      const realCalls = 1;
      const d1 = await claimRemainder("s1", "Grep", { id: "E-1" });
      const d2 = await claimRemainder("s1", "Bash", { id: "E-1" });
      expect(d1).toMatchObject({ program: "pr_summary", tool: "Grep" });
      expect(d2).toMatchObject({ program: "pr_summary", tool: "Bash" });
      const denies = [d1, d2].filter(Boolean).length;
      expect(realCalls).toBe(1);
      expect(denies).toBe(2);
      // Tail exhausted — a third Grep is not claimed.
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("partial-input match: tail call that only carries the entity id is claimed", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s1", pr, { id: "E-1", text: "refund please" })).toBe(true);
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toMatchObject({ tool: "Grep" });
    } finally {
      restore();
    }
  });

  test("matched-calls budget: same-entity noise burns the arming; then the tail is not claimed", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s1", pr, { id: "E-1" })).toBe(true);
      // rest = 2, slack = 32 → budget 34. 34 matching pings expire the arming.
      for (let i = 0; i < ARM_SLACK_CALLS + 2; i++) {
        expect(await claimRemainder("s1", "ping", { id: "E-1" })).toBeNull();
      }
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("a different entity is not claimed", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s1", pr, { id: "E-1" })).toBe(true);
      expect(await claimRemainder("s1", "Grep", { id: "E-2" })).toBeNull();
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toMatchObject({ tool: "Grep" });
    } finally {
      restore();
    }
  });

  test("session isolation: session A's remainder does not deny session B", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("sessA", pr, { id: "E-1" })).toBe(true);
      expect(await claimRemainder("sessB", "Grep", { id: "E-1" })).toBeNull();
      expect(await claimRemainder("sessA", "Grep", { id: "E-1" })).toMatchObject({ program: "pr_summary" });
    } finally {
      restore();
    }
  });

  test("fail-open at cap: extra arming is refused, live armings are not evicted", async () => {
    const { restore } = isolate();
    process.env.EDEN_ARM_MAX = "1";
    try {
      expect(await armRemainder("s1", pr, { id: "E-1" })).toBe(true);
      expect(await armRemainder("s1", { ...pr, name: "other", id: "t2" }, { id: "E-9" })).toBe(false);
      // First arming still claims. Second never armed.
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toMatchObject({ program: "pr_summary" });
      expect(await claimRemainder("s1", "Grep", { id: "E-9" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("fail-open: locker throw does not deny the call", async () => {
    const { restore } = isolate();
    try {
      const boom = () => {
        throw new Error("disk");
      };
      expect(await armRemainder("s1", pr, { id: "E-1" }, boom)).toBe(false);
      expect(await claimRemainder("s1", "Grep", { id: "E-1" }, boom)).toBeNull();
    } finally {
      restore();
    }
  });

  test("native Claude Read/Grep/Write inputs (file_path, not issue) claim remainder", async () => {
    const { restore } = isolate();
    try {
      const file = "/Users/me/repo/a.ts";
      const names = await armRemainderFromBatch(
        "claude-live",
        [
          { tool_name: "Read", tool_input: { file_path: file } },
          { tool_name: "Grep", tool_input: { pattern: "TODO", path: file } },
          { tool_name: "Write", tool_input: { file_path: file, content: "x" } },
        ],
        [{ name: "pr_write", sequence: ["Read", "Grep", "Write"], id: "t-write" }],
      );
      expect(names).toEqual(["pr_write"]);
      expect(await claimRemainder("claude-live", "Grep", { pattern: "TODO", path: file })).toMatchObject({
        tool: "Grep",
        program: "pr_write",
      });
      expect(await claimRemainder("claude-live", "Write", { file_path: file })).toMatchObject({ tool: "Write" });
      expect(await claimRemainder("claude-live", "Write", { file_path: "/other.ts" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("armRemainderFromBatch arms rest names when head is in the batch", async () => {
    const { restore } = isolate();
    try {
      const names = await armRemainderFromBatch(
        "s1",
        [
          { tool_name: "Read", tool_input: { id: "E-1" } },
          { tool_name: "Grep", tool_input: { id: "E-1" } },
          { tool_name: "Bash", tool_input: { id: "E-1" } },
        ],
        [pr],
      );
      expect(names).toContain("pr_summary");
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toMatchObject({ tool: "Grep" });
      expect(await claimRemainder("s1", "Bash", { id: "E-1" })).toMatchObject({ tool: "Bash" });
    } finally {
      restore();
    }
  });

  test("armRemainderFromBatch arms rest names when head was already served this session", async () => {
    const { restore } = isolate();
    try {
      const names = await armRemainderFromBatch(
        "s1",
        [
          { tool_name: "Grep", tool_input: { id: "E-1" } },
          { tool_name: "Bash", tool_input: { id: "E-1" } },
        ],
        [pr],
        undefined,
        { servedHeads: new Set(["Read"]) },
      );
      expect(names).toEqual(["pr_summary"]);
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toMatchObject({ program: "pr_summary" });
      expect(await claimRemainder("s1", "Bash", { id: "E-1" })).toMatchObject({ program: "pr_summary" });
    } finally {
      restore();
    }
  });

  test("armRemainderFromBatch does not arm when head was never served and is not in the batch", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainderFromBatch("s1", [{ tool_name: "Grep", tool_input: { id: "E-1" } }], [pr])).toEqual([]);
      expect(await claimRemainder("s1", "Grep", { id: "E-1" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("empty live catalog and unique-work sequences arm 0", async () => {
    const { restore } = isolate();
    try {
      const batch = [
        { tool_name: "Read", tool_input: { file_path: "/a.ts" } },
        { tool_name: "Grep", tool_input: { pattern: "TODO", path: "/a.ts" } },
        { tool_name: "Write", tool_input: { file_path: "/a.ts", content: "x" } },
      ];
      expect(await armRemainderFromBatch("s-empty", batch, [])).toEqual([]);
      expect(await claimRemainder("s-empty", "Write", { file_path: "/a.ts" })).toBeNull();
      expect(
        await armRemainderFromBatch("s-unique", batch, [
          { name: "fetch_then_bash", sequence: ["WebFetch", "Bash"], id: "t-unique" },
        ]),
      ).toEqual([]);
      expect(await claimRemainder("s-unique", "Write", { file_path: "/a.ts" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("same path with a disagreeing ticket id is not claimed", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s1", pr, { id: "E-1", file_path: "/a.ts" })).toBe(true);
      expect(await claimRemainder("s1", "Grep", { id: "E-2", path: "/a.ts" })).toBeNull();
      expect(await claimRemainder("s1", "Grep", { id: "E-1", path: "/a.ts" })).toMatchObject({ tool: "Grep" });
    } finally {
      restore();
    }
  });

  test("batch identity prefers the program head's path when the batch is mixed", async () => {
    const { restore } = isolate();
    try {
      const names = await armRemainderFromBatch(
        "s-mix",
        [
          { tool_name: "Grep", tool_input: { pattern: "TODO", path: "/other.ts" } },
          { tool_name: "Read", tool_input: { file_path: "/a.ts" } },
          { tool_name: "Write", tool_input: { file_path: "/a.ts", content: "x" } },
        ],
        [{ name: "pr_write", sequence: ["Read", "Grep", "Write"], id: "t-write" }],
      );
      expect(names).toEqual(["pr_write"]);
      expect(await claimRemainder("s-mix", "Write", { file_path: "/a.ts" })).toMatchObject({ tool: "Write" });
      expect(await claimRemainder("s-mix", "Write", { file_path: "/other.ts" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("parseToolCalls: missing or garbage is null; named items parse", () => {
    expect(parseToolCalls(undefined)).toBeNull();
    expect(parseToolCalls("nope")).toBeNull();
    expect(parseToolCalls({ tool_name: "Read" })).toBeNull();
    expect(parseToolCalls([])).toEqual([]);
    expect(parseToolCalls([{ tool_name: "Grep", tool_input: { id: "E-1" } }])).toEqual([
      { tool_name: "Grep", tool_input: { id: "E-1" } },
    ]);
  });

  test("host-drop ledger row carries the canvas sentence (replica/shape-mismatch writer)", () => {
    const { home, restore } = isolate();
    try {
      appendLedgerRow({ session: "s1", class: "host-drop", program: "pr_summary", programId: "t1", tool: "Read" });
      const ledger = readFileSync(ledgerPath(), "utf8");
      expect(ledger).toContain('"class":"host-drop"');
      expect(hostDropReason()).toMatch(/dropped the rewrite/i);
      expect(home).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("host-drop receipt POST is degraded, with no skipped list and no token class", () => {
    const { home, restore } = isolate();
    const prevFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/v1/receipts") && typeof init?.body === "string") {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch.preconnect },
    );
    try {
      appendLedgerRow({ session: "s1", class: "host-drop", program: "pr_summary", programId: "t1", tool: "Read" });
      expect(bodies).toHaveLength(1);
      const body = bodies[0]!;
      expect(body.ok).toBe(true);
      expect(body.outcome).toBe("degraded");
      expect(body.reason).toBe(hostDropReason());
      expect(body.skipped).toBeUndefined();
      expect(body.tokenClass).toBeUndefined();
      expect(body.tokenClasses).toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      restore();
    }
  });

  test("steered-skip and transparent receipts omit tokenClasses when unmeasured — never invent", () => {
    const { home, restore } = isolate();
    const prevFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/v1/receipts") && typeof init?.body === "string") {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch.preconnect },
    );
    try {
      appendLedgerRow({ session: "s1", class: "transparent", program: "pr_summary", programId: "t1" });
      appendLedgerRow({ session: "s1", class: "steered-skip", program: "pr_summary", programId: "t1", tool: "Grep" });
      expect(bodies).toHaveLength(2);
      const transparent = bodies[0]!;
      const skip = bodies[1]!;
      expect(transparent.tokenClass).toBe("transparent");
      expect(transparent.tokenClasses).toBeUndefined();
      expect(transparent.prompt_tokens).toBeUndefined();
      expect(skip.tokenClass).toBe("steered-skip");
      expect(skip.skipped).toEqual(["Grep"]);
      expect(skip.tokenClasses).toBeUndefined();
      expect(skip.prompt_tokens).toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      restore();
    }
  });
});

const CWD = "/Users/me/repo";
const REL = "./a.ts";
const ABS = resolve(CWD, REL);
const writeProg = { name: "pr_write", sequence: ["Read", "Grep", "Write"], id: "t-write" };

describe("remainder path identity (cwd-join)", () => {
  test("wrap hintIdOf still ignores file_path; remainder-local hint is the resolved path", () => {
    expect(hintIdOf({ file_path: REL })).toBeUndefined();
    expect(hintIdOf({ file_path: ABS })).toBeUndefined();
    expect(hintIdOf({ path: ABS })).toBeUndefined();
    expect(hintIdOf({ id: "E-1", file_path: ABS })).toBe("E-1");
    expect(joinAgainstCwd(REL, CWD)).toBe(ABS);
    expect(remainderHintOf({ file_path: joinAgainstCwd(REL, CWD) })).toBe(ABS);
  });

  test("./a.ts and the absolute form of the same file both claim when cwd is set", async () => {
    const { home, restore } = isolate();
    try {
      expect(await armRemainder("s-cwd", writeProg, { file_path: REL }, undefined, CWD)).toBe(true);
      const store = JSON.parse(readFileSync(remainderPath(), "utf8")) as {
        sessions: Record<string, { byKey: Record<string, { hintId: unknown; input: Record<string, unknown> }> }>;
      };
      const row = Object.values(Object.values(store.sessions)[0]!.byKey)[0]!;
      expect(row.hintId).toBe(ABS);
      expect(row.input.file_path).toBe(ABS);
      expect(await claimRemainder("s-cwd", "Grep", { pattern: "TODO", path: REL }, undefined, undefined, CWD)).toMatchObject({
        tool: "Grep",
        program: "pr_write",
      });
      expect(await claimRemainder("s-cwd", "Write", { file_path: ABS }, undefined, undefined, CWD)).toMatchObject({
        tool: "Write",
      });
      expect(home).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("absolute arm claims relative ./a.ts (same join)", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s-abs", writeProg, { file_path: ABS }, undefined, CWD)).toBe(true);
      expect(await claimRemainder("s-abs", "Write", { file_path: REL }, undefined, undefined, CWD)).toMatchObject({
        tool: "Write",
      });
    } finally {
      restore();
    }
  });

  test("without cwd, relative vs abs still does not claim", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s-nocwd", writeProg, { file_path: REL })).toBe(true);
      expect(await claimRemainder("s-nocwd", "Write", { file_path: ABS })).toBeNull();
      expect(await claimRemainder("s-nocwd", "Write", { file_path: REL })).toMatchObject({ tool: "Write" });
    } finally {
      restore();
    }
  });

  test("disagreeing id/issue on the same resolved path still refuses", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s-id", pr, { id: "E-1", file_path: REL }, undefined, CWD)).toBe(true);
      expect(await claimRemainder("s-id", "Grep", { id: "E-2", path: ABS }, undefined, undefined, CWD)).toBeNull();
      expect(await claimRemainder("s-id", "Grep", { id: "E-1", path: ABS }, undefined, undefined, CWD)).toMatchObject({
        tool: "Grep",
      });

      expect(await armRemainder("s-issue", pr, { issue: "I-1", file_path: REL }, undefined, CWD)).toBe(true);
      expect(await claimRemainder("s-issue", "Grep", { issue: "I-2", path: ABS }, undefined, undefined, CWD)).toBeNull();
      expect(await claimRemainder("s-issue", "Grep", { issue: "I-1", path: ABS }, undefined, undefined, CWD)).toMatchObject({
        tool: "Grep",
      });
    } finally {
      restore();
    }
  });

  test("mixed-file batch takes the program head after cwd-join", async () => {
    const { restore } = isolate();
    try {
      const names = await armRemainderFromBatch(
        "s-mix-rel",
        [
          { tool_name: "Grep", tool_input: { pattern: "TODO", path: "./other.ts" } },
          { tool_name: "Read", tool_input: { file_path: REL } },
          { tool_name: "Write", tool_input: { file_path: REL, content: "x" } },
        ],
        [writeProg],
        undefined,
        { cwd: CWD },
      );
      expect(names).toEqual(["pr_write"]);
      expect(await claimRemainder("s-mix-rel", "Write", { file_path: ABS }, undefined, undefined, CWD)).toMatchObject({
        tool: "Write",
      });
      expect(await claimRemainder("s-mix-rel", "Write", { file_path: resolve(CWD, "./other.ts") }, undefined, undefined, CWD)).toBeNull();
    } finally {
      restore();
    }
  });

  test("../other relative to cwd does not claim a.ts", async () => {
    const { restore } = isolate();
    try {
      expect(await armRemainder("s-trav", writeProg, { file_path: REL }, undefined, CWD)).toBe(true);
      expect(await claimRemainder("s-trav", "Write", { file_path: "../other" }, undefined, undefined, CWD)).toBeNull();
      expect(await claimRemainder("s-trav", "Write", { file_path: "../secret" }, undefined, undefined, CWD)).toBeNull();
      expect(await claimRemainder("s-trav", "Write", { file_path: ABS }, undefined, undefined, CWD)).toMatchObject({
        tool: "Write",
      });
    } finally {
      restore();
    }
  });
});
