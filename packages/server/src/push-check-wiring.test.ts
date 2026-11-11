import { describe, expect, test } from "bun:test";
import { CHECK_SYSTEM } from "@eden/engine";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { buildPartner } from "./build";
import { modelRolesFromEnv } from "./models";

/**
 * The push check is in the default (D828): a server with a model key wires it on the reader's model, with a budget of
 * its own, and every push whose pool passes the constraint-like gate makes its call. This pins that wiring, the switch
 * that takes it out, and that a failing check still hands the agent the unchecked candidates and logs once, keyless.
 */

const KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

/** Stands in for the role model: records each request; answers "nothing changes it", or throws with the key. */
class RoleModel implements Model {
  readonly calls: ChatRequest[] = [];
  constructor(
    readonly id: string,
    private readonly fails: boolean,
  ) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    if (this.fails) throw new Error(`openrouter 503: upstream busy (key ${KEY})`);
    const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 };
    return { text: '{"items":[]}', usage, costUsd: 0, model: this.id, latencyMs: 0, truncated: false };
  }
}

// Constraint wording, so the candidates' gate passes and the check is asked.
const docs = [
  { ref: "hold", title: "Harlow venue", text: "Do not pay anything to Harlow until Dee has checked their numbers." },
  { ref: "inv", title: "Harlow invoice", text: "Harlow venue deposit invoice, due Friday." },
];

function serve(engine: Record<string, unknown>, fails = false) {
  const models: RoleModel[] = [];
  const roles = modelRolesFromEnv({ OPENROUTER_API_KEY: KEY }, (o) => {
    const m = new RoleModel(o.model, fails);
    models.push(m);
    return m;
  });
  const lines: string[] = [];
  const partner = buildPartner({
    sources: async () => [new StaticSource("mail", "Mail", docs)],
    models: roles,
    queryPlanner: "off",
    // Cards would call the same model in the background; this test is about the push.
    engine: { cards: false, intent: false, sync: false, ...engine },
    log: (line) => lines.push(line),
  });
  const checks = () => models.flatMap((m) => m.calls).filter((c) => c.messages[0]!.content === CHECK_SYSTEM);
  return { partner, lines, checks };
}

const at = { tenantId: "t", userId: "u1", sessionId: "s1" };
async function push(partner: ReturnType<typeof buildPartner>) {
  await partner.observe(
    { ...at, at: Date.now(), kind: "user_message", text: "Pay the Harlow venue deposit invoice" } as AgentEvent,
    {
      waitMs: 3_000,
    },
  );
  return partner.takePending(at).filter((x) => x.reason.startsWith("candidates:"));
}

describe("the push check in the servers (D828)", () => {
  test("with a key the default checks the push; a check naming nothing sends no packet", async () => {
    const { partner, checks } = serve({});
    expect(await push(partner)).toEqual([]);
    expect(checks().length).toBe(1);
  });

  test("`pushCheck: false` (the part `check` out) makes no call and hands the candidates", async () => {
    const { partner, checks } = serve({ pushCheck: false });
    expect((await push(partner)).length).toBe(1);
    expect(checks().length).toBe(0);
  });

  test("a failing check fails open to the candidates and logs one line without the key", async () => {
    const { partner, lines, checks } = serve({}, true);
    const got = await push(partner);
    expect(checks().length).toBe(1);
    expect(got.length).toBe(1);
    expect(got[0]!.citations.length).toBeGreaterThan(0);
    const logged = lines.filter((l) => l.includes("push check"));
    expect(logged.length).toBe(1);
    expect(logged[0]).not.toContain(KEY);
  });
});
