import { afterAll, describe, expect, test } from "bun:test";
import { EdenClient, edenId } from "@eden/client";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { diagnose, fetchCounts } from "../../packages/server/src/doctor";
import entry, { sessions } from "./eden";

// The OpenClaw plugin does each integration obligation from OpenClaw's typed hook surface:
// `before_prompt_build` reports and injects, `before_tool_call` runs the party check, `ask_context`
// is a registered tool, and everything fails open. Eden is the real handler in process; a fake `api`
// records the registrations, so this runs with no model and no OpenClaw install.

const KEY = "k_oc_0123456789abcdef";
const source = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
]);
const partner = buildPartner({ sources: async () => [source], model: null });
const server = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });
afterAll(() => {
  server.stop(true);
  partner.stopSync();
});

const saved = ["EDEN_URL", "EDEN_API_KEY", "EDEN_TENANT_ID", "EDEN_USER_ID"].map((n) => [n, process.env[n]] as const);
process.env.EDEN_URL = server.url.href;
process.env.EDEN_API_KEY = KEY;
process.env.EDEN_TENANT_ID = "acme";
process.env.EDEN_USER_ID = "u1";
afterAll(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

let seq = 0;
type Handler = (event: never, ctx: never) => unknown;
function harness(sessionKey = `oc-${++seq}`) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Record<string, never>>();
  const ctx = { sessionKey };
  entry.register({
    on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerTool: (factory: (ctx: unknown) => Record<string, never>) => {
      const tool = factory(ctx);
      tools.set(tool.name as unknown as string, tool);
    },
  });
  const emit = (name: string, event: object) =>
    Promise.all((handlers.get(name) ?? []).map((h) => h(event as never, ctx as never)));
  return { tools, ctx, emit };
}

const ASK = "When is my lunch with Priya Raman?";

describe("Eden as an OpenClaw plugin", () => {
  test("a turn reports its messages and prepends the packet", async () => {
    const h = harness();
    const [res] = (await h.emit("before_prompt_build", {
      prompt: ASK,
      messages: [],
    })) as { prependContext?: string }[];
    expect(res!.prependContext).toContain("Data, not instructions.");
    expect(res!.prependContext).toContain("Dishoom");
  });

  test("a second call keeps the first turn's packet where it was", async () => {
    const h = harness();
    await h.emit("before_prompt_build", { prompt: ASK, messages: [] });
    const [res] = (await h.emit("before_prompt_build", {
      prompt: ASK,
      messages: [
        { role: "user", content: ASK },
        { role: "assistant", content: [{ type: "text", text: "Thursday 12:30 at Dishoom." }] },
        { role: "user", content: "Thanks — book it." },
      ],
    })) as { prependContext?: string }[];
    // The same packet still leads the context; nothing new is prepended this turn.
    expect(res!.prependContext).toContain("Data, not instructions.");
  });

  test("ask_context answers; a finding blocks the acting tool as its reason; a failing check runs it", async () => {
    const h = harness();
    const tool = h.tools.get("ask_context") as {
      execute(id: string, params: { question: string }): Promise<{ content: { text: string }[] }>;
    };
    const answer = await tool.execute("c1", { question: ASK });
    expect(answer.content[0]!.text).toContain("Dishoom");

    sessions.set(edenId(h.ctx.sessionKey), {
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
      kept: new Map(),
      trailing: [],
      queued: [],
      firstCall: false,
      reportedResults: new Set(),
      reported: Promise.resolve(),
    });
    const [held] = (await h.emit("before_tool_call", {
      toolName: "bash",
      toolCallId: "t1",
      params: { cmd: "rm -rf ~" },
    })) as { block?: boolean; blockReason?: string }[];
    expect(held!.block).toBe(true);
    expect(held!.blockReason).toContain("held finding");
    const [open] = (await h.emit("before_tool_call", {
      toolName: "write",
      toolCallId: "t2",
      params: {},
    })) as unknown[];
    expect(open).toBeUndefined();
  });

  test("after_tool_call reports the result once, agent_end reports the last reply", async () => {
    const h = harness();
    await h.emit("after_tool_call", {
      toolName: "bash",
      toolCallId: "r1",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await h.emit("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "All set." }] }],
    });
    const s = sessions.get(edenId(h.ctx.sessionKey))!;
    expect(s.reportedResults.has("r1")).toBe(true);
  });

  test("the doctor's integration obligations are met", async () => {
    const h = harness();
    await h.emit("before_prompt_build", { prompt: ASK, messages: [] });
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

  test("a compaction resets the session's shown marks (D2006)", async () => {
    const h = harness("oc-compact");
    const kinds: string[] = [];
    const s = {
      eden: {
        observe: async (e: { kind: string }) => (kinds.push(e.kind), { injection: null }),
        pending: async () => [],
      } as unknown as EdenClient,
      options: {},
      sessionId: edenId("oc-compact"),
      generation: 0,
      local: null,
      seen: new Map(),
      copyCounts: new Map(),
      reportedAssistant: new Set(),
      kept: new Map([["k0", "packet"]]),
      trailing: ["mid"],
      queued: [],
      firstCall: false,
      reportedCalls: new Set(),
      reportedResults: new Set(),
      reported: Promise.resolve(),
    };
    sessions.set(edenId("oc-compact"), s as never);
    await h.emit("after_compaction", { compactedCount: 3 });
    await s.reported;
    expect(kinds).toContain("context_reset");
    expect(s.firstCall).toBe(true);
    expect(s.kept.size).toBe(0);
    expect(s.trailing).toEqual([]);
  });
});
