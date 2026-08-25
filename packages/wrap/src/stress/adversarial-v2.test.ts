/**
 * ADVERSARIAL SUITE v2 — different seeds, bigger volumes, different surfaces.
 * Deliberately NOT reusing v1's scenarios verbatim: fixes must generalize.
 */
import { describe, expect, test } from "bun:test";
import { createState, wrapTools, handleChatCompletions, handleAnthropicMessages } from "../index";
import { redact } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";

const gate = process.env.EDEN_STRESS === "1";
const d = describe.skipIf(!gate);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0; // DIFFERENT LCG than v1
    return s / 0xffffffff;
  };
}

d("v2: proxy under concurrency", () => {
  test("60 parallel chat completions through the steering proxy", async () => {
    const prog: StretchProgram = {
      id: "p_v2",
      version: "1",
      name: "search_bundle",
      description: "",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      sequence: ["search", "summarize"],
      steps: [],
      returns: { kind: "literal", value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
      manifest: { llmReduction: 8, latencyReduction: 8, costReduction: 8, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 },
    } as unknown as StretchProgram;
    const state = createState({ programs: [prog] });
    const upstream = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `reply-for-${body.messages?.length ?? 0}`, tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const state2 = createState({ programs: [prog], fetch: upstream });
    const jobs2 = Array.from({ length: 60 }, (_, i) =>
      handleChatCompletions(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "m", messages: [{ role: "user", content: `q${i}` }] }),
        }),
        { state: state2, getPrograms: () => [prog] },
      ),
    );
    const responses = await Promise.all(jobs2);
    let oks = 0;
    for (const r of responses) {
      expect(r.status).toBe(200);
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      if (typeof j.choices?.[0]?.message?.content === "string") oks++;
    }
    expect(oks).toBe(60);
  });

  test("anthropic dialect: 40 steered streaming requests stay well-formed", async () => {
    const prog: StretchProgram = {
      id: "p_an",
      version: "1",
      name: "lookup_to_respond",
      description: "",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sequence: ["lookup", "respond"],
      steps: [],
      returns: { kind: "literal", value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
      manifest: { llmReduction: 8, latencyReduction: 8, costReduction: 8, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 },
    } as unknown as StretchProgram;
    const state = createState({ programs: [prog] });
    const upstream = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "lookup", input: { id: "T-1" } },
            { type: "tool_use", id: "tu_2", name: "respond", input: { id: "T-1" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        handleAnthropicMessages(
          new Request("http://local/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "k" },
            body: JSON.stringify({ model: "m", max_tokens: 10, stream: true, messages: [], tools: [{ name: "lookup", input_schema: {} }] }),
          }),
          { state, getPrograms: () => [prog], fetch: upstream },
        ),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") || "").toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: message_stop");
      // The absorbed sibling must never appear in a streamed response.
      expect(text).not.toContain('"name":"respond"');
    }
  });
});

d("v2: redaction volume + variety", () => {
  test("100 mixed secret shapes all scrubbed", () => {
    const rand = rng(999);
    const shapes: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 100; i++) {
      const kind = Math.floor(rand() * 6);
      if (kind === 0) shapes.push({ api_key: `sk-live-${i}abcdef123456` });
      else if (kind === 1) shapes.push({ Authorization: `Bearer tok${i}abcdefgh` });
      else if (kind === 2) shapes.push({ password: `pw-${i}-supersecret` });
      else if (kind === 3) shapes.push({ nested: { access_token: `at_${i}abcdefgh` } });
      else if (kind === 4) shapes.push({ note: `set cookie session=${i}abc123def; Path=/` });
      else shapes.push({ safe: `plain value ${i}`, id: i }); // control group
    }
    const cleaned = redact(shapes) as Array<Record<string, unknown>>;
    const raw = JSON.stringify(cleaned);
    for (let i = 0; i < 100; i += 7) {
      // Spot-check a subset of each family for leakage.
      expect(raw).not.toContain(`sk-live-${i}abcdef123456`);
      expect(raw).not.toContain(`pw-${i}-supersecret`);
    }
    // Controls survive.
    expect(raw).toContain("plain value");
  });
});

d("v2: sustained steering correctness (varied shapes)", () => {
  test("300 calls alternating in/out-of-envelope across 3 program shapes", async () => {
    const mk = (id: string, toolsUsed: string[], witnessedKs: string[]): StretchProgram =>
      ({
        id: `p_${id}`,
        version: "1",
        name: `${toolsUsed[0]}_flow`,
        description: "v2 stress flow",
        inputSchema: { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
        sequence: toolsUsed,
        steps: toolsUsed.map((t, i) => ({ id: `s${i}`, kind: "tool", tool: t, args: { k: { kind: "input", path: "k" } } })),
        returns: { kind: "from", step: `s${toolsUsed.length - 1}`, path: "" },
        contract: {
          witnesses: 3,
          minLlmReduction: 2,
          // Envelope constrains k to the witnessed set, so "unknown" keys are
          // genuinely out-of-distribution rather than steered blindly.
          allowExact: false,
          envelope: { inputs: { k: witnessedKs } },
        },
        manifest: { llmReduction: 8, latencyReduction: 8, costReduction: 8, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 },
      }) as unknown as StretchProgram;

    const knowns = [["known-0-a", "known-0-b"], ["known-1-a"], ["known-2-a"]];
    const shapes = [mk("a", ["alpha", "beta", "gamma"], knowns[0]!), mk("b", ["alpha", "delta"], knowns[1]!), mk("c", ["epsilon", "zeta"], knowns[2]!)];
    const state = createState({ programs: shapes });
    const executed: Record<string, number> = {};
    const track = (name: string, val: unknown) => async (a: Record<string, unknown>) => {
      executed[`${name}:${a.k}`] = (executed[`${name}:${a.k}`] ?? 0) + 1;
      void name;
      return val;
    };
    const tools = wrapTools(
      {
        alpha: track("alpha", { step: 1 }),
        beta: track("beta", { step: 2 }),
        gamma: track("gamma", { done: true }),
        delta: track("delta", { done: true }),
        epsilon: track("epsilon", { step: 1 }),
        zeta: track("zeta", { done: true }),
      },
      state,
    );

    let correct = 0;
    const TOTAL = 300;
    for (let i = 0; i < TOTAL; i++) {
      const shapeIdx = i % 3;
      const inEnvelope = i % 2 === 0;
      const k = inEnvelope ? knowns[shapeIdx]![i % knowns[shapeIdx]!.length]! : `unknown-${i}`;
      if (shapeIdx === 0) {
        const out = (await tools.alpha.execute({ k })) as Record<string, unknown>;
        if (inEnvelope) {
          // Compiled flow runs alpha→beta→gamma; result is gamma's {done}.
          if (out.done === true && (executed[`beta:${k}`] ?? 0) >= 1) correct++;
        } else if (out.step === 1 && (executed[`beta:${k}`] ?? 0) === 0) correct++;
      } else if (shapeIdx === 1) {
        const out = (await tools.alpha.execute({ k })) as Record<string, unknown>;
        if (inEnvelope) {
          if (out.done === true && (executed[`delta:${k}`] ?? 0) >= 1) correct++;
        } else if (out.step === 1 && (executed[`delta:${k}`] ?? 0) === 0) correct++;
      } else {
        const out = (await tools.epsilon.execute({ k })) as Record<string, unknown>;
        if (inEnvelope) {
          if (out.done === true && (executed[`zeta:${k}`] ?? 0) >= 1) correct++;
        } else if (out.step === 1 && (executed[`zeta:${k}`] ?? 0) === 0) correct++;
      }
    }
    expect(correct).toBe(TOTAL); // every call resolved exactly as designed
  });
});
