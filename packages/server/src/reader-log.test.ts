import { describe, expect, test } from "bun:test";
import type { ChatRequest, ChatResponse, Model, OpenRouterOptions } from "@eden/llm";
import { StaticSource } from "@eden/sources";
import { buildPartner, modelFailures, readerFailureLog } from "./build";
import { DEFAULT_ROLE_MODEL, keyScrubber, modelRolesFromEnv } from "./models";

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

  test("every failure is counted by role for /metrics, though the line is written once", () => {
    const before = { ...modelFailures };
    const reader = readerFailureLog(() => {});
    const check = readerFailureLog(() => {}, undefined, "check failed", "check");
    for (let i = 0; i < 3; i++) reader(new Error("openrouter 403"));
    check(new Error("openrouter 403"));
    check(new Error("push check reply unreadable (cut off at the token cap, or not the expected JSON)"));
    expect(modelFailures["reader:error"] - before["reader:error"]).toBe(3);
    expect(modelFailures["check:error"] - before["check:error"]).toBe(1);
    // An unreadable reply is routine (about 2% of checks) and counted apart: the alert reads errors only.
    expect(modelFailures["check:unreadable"] - before["check:unreadable"]).toBe(1);
  });

  test("without a key there is no reader, so nothing to log", () => {
    const roles = modelRolesFromEnv({}, () => {
      throw new Error("no model is made without a key");
    });
    expect(roles.reader).toBeNull();
    expect(roles.scrub).toBeUndefined();
  });
});

describe("what a provider's error carries besides its message never reaches the log (review of D1830)", () => {
  test("OpenRouter's account id is replaced, whole, cut off or bare", () => {
    const lines: string[] = [];
    const body =
      'openrouter 403: {"error":{"message":"The request is prohibited due to a violation of provider Terms Of ' +
      'Service.","code":403},"user_id":"user_2uSUyeSClJeAbCdEf"}';
    readerFailureLog((l) => lines.push(l))(new Error(body));
    readerFailureLog((l) => lines.push(l))(new Error('openrouter 403: {"user_id" : "user_2uSUyeSClJe'));
    readerFailureLog((l) => lines.push(l))(new Error("openrouter 403: denied for user_id=user_2uSUyeSClJe, retry"));
    for (const line of lines) expect(line).not.toContain("user_2uSUyeSClJe");
    expect(lines[0]).toContain('"user_id":"[id]"');
    expect(lines[0]).toContain("Terms Of Service");
    expect(lines[1]).toContain('"user_id" : "[id]"');
    expect(lines[2]).toContain("user_id=[id], retry");
  });

  test("the key is scrubbed as echoed: whole, its last 16, base64 of it and of its Bearer header, split by spaces", () => {
    const scrub = keyScrubber(KEY);
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_");
    const forms = [
      KEY,
      `****${KEY.slice(-16)}`,
      b64(KEY),
      b64(`Bearer ${KEY}`),
      url(b64(`Bearer ${KEY}`)),
      `${KEY.slice(0, 20)}\n${KEY.slice(20)}`,
      `${KEY.slice(0, 9)} ${KEY.slice(9, 40)}\r\n  ${KEY.slice(40)}`,
      `${b64(KEY).slice(0, 30)}\n${b64(KEY).slice(30)}`,
    ];
    for (const form of forms) {
      const out = scrub(`openrouter 401: echo ${form} end`);
      expect(out).toContain("[key]");
      expect(out).toContain("end");
      expect(out.replace(/\s+/g, "")).not.toContain(KEY.slice(-16));
      expect(out.replace(/\s+/g, "")).not.toContain(b64(KEY).slice(0, 40));
    }
    // Text that only shares a prefix with the key is left alone; the short key is scrubbed too.
    expect(scrub("sk-or-v1-something else")).toBe("sk-or-v1-something else");
    expect(keyScrubber(SHORT_KEY)(`a ${SHORT_KEY} b`)).toBe("a [key] b");
    // The roles' scrub is this one.
    expect(modelRolesFromEnv({ OPENROUTER_API_KEY: KEY }, () => new RefusingModel("m", "")).scrub!(b64(KEY))).toBe(
      "[key]",
    );
  });
});
