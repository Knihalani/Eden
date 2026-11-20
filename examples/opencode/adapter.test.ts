import { afterAll, describe, expect, test } from "bun:test";
import { EdenClient, edenId } from "@eden/client";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { diagnose, fetchCounts } from "../../packages/server/src/doctor";
import Eden from "./eden";

// The plugin's live sessions are reached through globalThis: opencode's legacy loader calls
// every named export as a plugin function, so `sessions` cannot be an export.
const sessions = (globalThis as Record<string, unknown>).__edenOpencodeSessions as Map<string, any>;

// The opencode plugin does each integration obligation from opencode's V1 hook surface: the
// messages transform reports and injects, `tool.execute.before` runs the party check and throws
// to block, `ask_context` is a registered tool, and everything fails open. Eden is the real
// handler in process; the plugin factory returns the hooks object, so this runs with no model
// and no opencode install.

const KEY = "k_ocd_0123456789abcdef";
const source = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
]);
const partner = buildPartner({ sources: async () => [source], model: null });
const server = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });
afterAll(() => {
  server.stop(true);
  partner.stopSync();
});

const saved = ["EDEN_URL", "EDEN_API_KEY", "EDEN_TENANT_ID", "EDEN_USER_ID", "OPENCODE_HOME"].map(
  (n) => [n, process.env[n]] as const,
);
process.env.EDEN_URL = server.url.href;
process.env.EDEN_API_KEY = KEY;
process.env.EDEN_TENANT_ID = "acme";
process.env.EDEN_USER_ID = "u1";
delete process.env.OPENCODE_HOME;
afterAll(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

let seq = 0;
type Hooks = Awaited<ReturnType<typeof Eden>>;
async function harness(
  sessionID = `ocd-${++seq}`,
  transcript?: { info: { role: string }; parts: { type: string; text: string }[] }[],
) {
  const ctx = {
    client: {
      session: {
        messages: async () => ({ data: transcript ?? [] }),
      },
    },
  };
  const hooks = await Eden(ctx);
  return { hooks, sessionID };
}

const ASK = "When is my lunch with Priya Raman?";
const userMsg = (id: string, sessionID: string, text: string) => ({
  info: { id, role: "user", sessionID },
  parts: [{ id: `${id}-p0`, type: "text", text }],
});

describe("Eden as an opencode plugin", () => {
  test("a turn reports its messages and injects the packet on the last user message", async () => {
    const { hooks, sessionID } = await harness();
    const output = { messages: [userMsg("m1", sessionID, ASK)] };
    await hooks["experimental.chat.messages.transform"]!({}, output as never);
    const injected = output.messages[0]!.parts.filter((p) => (p.id ?? "").startsWith("eden-"));
    expect(injected.length).toBe(1);
    expect(injected[0]!.text).toContain("Dishoom");
  });

  test("a later call keeps the packet injected without duplicating it", async () => {
    const { hooks, sessionID } = await harness();
    const messages = [userMsg("m1", sessionID, ASK)];
    const output = { messages };
    await hooks["experimental.chat.messages.transform"]!({}, output as never);
    // The transform rebuilds the prompt each call: simulate the persisted list carrying the
    // injection forward — the same part id is not added twice.
    const output2 = { messages };
    await hooks["experimental.chat.messages.transform"]!({}, output2 as never);
    const injected = output2.messages[0]!.parts.filter((p) => (p.id ?? "").startsWith("eden-"));
    expect(injected.length).toBe(1);
  });

  test("a transcript tool part reports its call and result once", async () => {
    const { hooks, sessionID } = await harness();
    const kinds: string[] = [];
    sessions.set(edenId(sessionID), {
      eden: {
        observe: async (ev: { kind: string }) => (kinds.push(ev.kind), { injection: null }),
        pending: async () => [],
        check: async () => ({ verdict: "ok" }),
      } as unknown as EdenClient,
      options: {},
      generation: 1,
      local: null,
      seen: new Map(),
      copyCounts: new Map(),
      reportedAssistant: new Set(),
      kept: new Map<string, { text: string; messageID: string }>(),
      trailing: [],
      queued: [],
      firstCall: false,
      reportedCalls: new Set(),
      reportedResults: new Set(),
      reported: Promise.resolve(),
    });
    const msg = {
      info: { id: "a1", role: "assistant", sessionID },
      parts: [
        {
          id: "a1-t",
          type: "tool",
          tool: "bash",
          callID: "k1",
          state: { status: "completed", input: { cmd: "ls" }, output: "ok" },
        },
      ],
    };
    for (let i = 0; i < 2; i++) {
      await hooks["experimental.chat.messages.transform"]!({}, { messages: [msg] } as never);
    }
    expect(kinds.filter((k) => k === "tool_call").length).toBe(1);
    expect(kinds.filter((k) => k === "tool_result").length).toBe(1);
  });

  test("a kept packet stays anchored to its own user message", async () => {
    const { hooks, sessionID } = await harness();
    let injected = 0;
    sessions.set(edenId(sessionID), {
      eden: {
        observe: async (ev: { kind: string }) => ({
          injection: ev.kind === "user_message" && injected++ === 0 ? { id: "i1", text: "PACKET" } : null,
        }),
        pending: async () => [],
        check: async () => ({ verdict: "ok" }),
      } as unknown as EdenClient,
      options: {},
      generation: 1,
      local: null,
      seen: new Map(),
      copyCounts: new Map(),
      reportedAssistant: new Set(),
      kept: new Map<string, { text: string; messageID: string }>(),
      trailing: [],
      queued: [],
      firstCall: false,
      reportedCalls: new Set(),
      reportedResults: new Set(),
      reported: Promise.resolve(),
    });
    const u1 = userMsg("u1", sessionID, "hi");
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [u1] } as never);
    const u2 = userMsg("u2", sessionID, "more");
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [u1, u2] } as never);
    expect(u1.parts.filter((p) => p.text === "PACKET").length).toBe(1);
    expect(u2.parts.filter((p) => p.text === "PACKET").length).toBe(0);
    // u1 gone from the window: its packet goes with it instead of moving to u2.
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [u2] } as never);
    expect(u2.parts.filter((p) => p.text === "PACKET").length).toBe(0);
  });

  test("ask_context answers; a finding blocks the call with the held result; a failing check runs it", async () => {
    const { hooks, sessionID } = await harness();
    const tool = hooks.tool!.ask_context as {
      execute(args: { question: string }, ctx: { sessionID: string }): Promise<string>;
    };
    const answer = await tool.execute({ question: ASK }, { sessionID });
    expect(answer).toContain("Dishoom");

    sessions.set(edenId(sessionID), {
      eden: {
        observe: async () => ({ injection: null }),
        pending: async () => [],
        check: async (toolName: string) => {
          if (toolName === "bash") return { verdict: "finding", finding: { text: "held finding" } };
          throw new Error("down");
        },
      } as unknown as EdenClient,
      options: {},
      generation: 1,
      local: null,
      seen: new Map(),
      copyCounts: new Map(),
      reportedAssistant: new Set(),
      kept: new Map<string, { text: string; messageID: string }>(),
      trailing: [],
      queued: [],
      firstCall: false,
      reportedCalls: new Set(),
      reportedResults: new Set(),
      reported: Promise.resolve(),
    });
    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID, callID: "c1" }, { args: { cmd: "rm -rf ~" } }),
    ).rejects.toThrow("held finding");
    await expect(
      hooks["tool.execute.before"]!({ tool: "write", sessionID, callID: "c2" }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  test("tool.execute.after reports the result once; session.idle reports the last reply", async () => {
    const { hooks, sessionID } = await harness(undefined, [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "All set." }] },
    ]);
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID, callID: "r1" },
      { title: "bash", output: "done", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID, callID: "r1" },
      { title: "bash", output: "done", metadata: {} },
    );
    const s = sessions.get(edenId(sessionID))!;
    expect(s.reportedResults.has("r1")).toBe(true);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } });
    await s.reported;
    expect(s.reportedAssistant.size).toBe(1);
  });

  test("the doctor's integration obligations are met", async () => {
    const { hooks, sessionID } = await harness();
    const output = { messages: [userMsg("m1", sessionID, ASK)] };
    await hooks["experimental.chat.messages.transform"]!({}, output as never);
    const counts = await fetchCounts(server.url.href, KEY, { tenantId: "acme", userId: "u1" });
    const checks = diagnose(counts);
    for (const id of [
      "report-user-messages",
      "wait-on-user-message",
      "report-agent-side",
      "ask-context",
      "requests-accepted",
    ]) {
      expect(checks.find((c) => c.id === id)?.status, id).not.toBe("unmet");
    }
  });
});
