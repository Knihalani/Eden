import { describe, expect, test } from "bun:test";
import type { ChatRequest, ChatResponse, Model, OpenRouterOptions } from "@eden/llm";
import { StaticSource } from "@eden/sources";
import { buildPartner, readerFailureLog } from "./build";
import { DEFAULT_ROLE_MODEL, modelRolesFromEnv } from "./models";

/**
 * The shipped reader fails open (D41), so a reader whose every call fails (seen live: OpenRouter's 403 "violation of
 * provider Terms Of Service" on the default role model for one account) answered exactly like one that found
 * nothing. The server now logs the first failure, once, without the key; it still makes no startup probe.
 */

/** A realistic OpenRouter key shape and a short one the secret gate has no pattern for. */
const KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
const SHORT_KEY = "plainkey42";
const refusal = (key: string) =>
  `openrouter 403: {"error":{"message":"The request is prohibited due to a violation of provider Terms Of Service.",` +
  `"metadata":{"echo":"${key}"}}}`;

/** Stands in for OpenRouterModel: throws its non-2xx error, and counts calls. No network. */
class RefusingModel implements Model {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly message: string,
  ) {}
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    throw new Error(this.message);
  }
}

// Constraint wording, so the default's `readerGate` opens and the reader is called.
const docs = [
  { ref: "inv", title: "Harlow invoice", text: "Harlow venue deposit invoice, due Friday" },
  { ref: "hold", title: "Harlow venue", text: "Do not pay anything to Harlow until Dee has checked their numbers." },
  { ref: "plan", title: "Harlow floor plan", text: "Do not send the Harlow floor plan out before Monday." },
];

/** A partner built as main.ts builds it with a key, whose role models refuse every call. */
const serve = (key: string) => {
  const made: OpenRouterOptions[] = [];
  const models: RefusingModel[] = [];
  const roles = modelRolesFromEnv({ OPENROUTER_API_KEY: key }, (o) => {
    made.push(o);
    const m = new RefusingModel(o.model, refusal(key));
    models.push(m);
    return m;
  });
  const lines: string[] = [];
  const mail = new StaticSource("mail", "Mail", docs);
  const partner = buildPartner({
    sources: async () => [mail],
    models: roles,
    queryPlanner: "off",
    // Cards would call the same refusing model in the background; this test is about the reader, so it runs the
    // reader's push and asks (`pushCandidates` 0; the default's push reads nothing, D237).
    engine: { cards: false, intent: false, sync: false, pushCandidates: 0 },
    log: (line) => lines.push(line),
  });
  return { partner, lines, made, reader: models[0]! };
};

describe("the reader's failures are logged once by the server, without the key", () => {
  for (const key of [KEY, SHORT_KEY]) {
    test(`a 403 on every call: asks still answer, one line names the refusal, no key (${key.length} chars)`, async () => {
      const { partner, lines, made, reader } = serve(key);
      expect(made[0]!.model).toBe(DEFAULT_ROLE_MODEL);
      const scope = { tenantId: "t", userId: "u1" };
      const a = await partner.ask({ ...scope, sessionId: "s1", question: "Pay the Harlow venue deposit invoice" });
      const b = await partner.ask({ ...scope, sessionId: "s2", question: "Send the Harlow floor plan to the venue" });
      // Fail open: the rule paths answered both asks, though both readings failed.
      expect(reader.calls).toBe(2);
      expect(a.citations.map((c) => c.itemId)).toContain("mail:inv");
      expect(b.citations.length).toBeGreaterThan(0);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("openrouter 403");
      expect(lines[0]).toContain("Terms Of Service");
      expect(lines[0]).not.toContain(key);
    });
  }

  test("the log line is one line, bounded, redacted, and written at most once", () => {
    const lines: string[] = [];
    const log = readerFailureLog((l) => lines.push(l));
    log(new Error(`openrouter 500:\n${"x".repeat(5_000)} AKIAIOSFODNN7EXAMPLE`));
    log(new Error("second"));
    log("not an error");
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]!.length).toBeLessThan(600);
    const leaky = readerFailureLog((l) => lines.push(l));
    leaky(new Error("openrouter 401: key AKIAIOSFODNN7EXAMPLE rejected"));
    expect(lines[1]).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("without a key there is no reader, so nothing to log", () => {
    const roles = modelRolesFromEnv({}, () => {
      throw new Error("no model is made without a key");
    });
    expect(roles.reader).toBeNull();
    expect(roles.scrub).toBeUndefined();
  });
});
