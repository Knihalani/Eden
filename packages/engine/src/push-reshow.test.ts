import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// A17 (docs/research/a17-long-quality.md, D340): `pushReshow`. Over a user's day an item that ranks for one request is
// often pushed first as a candidate for another; at its own request the not-twice ledger kept it back. With the switch
// on, a candidate handed out for an earlier request is handed again when it ranks for this one and could constrain it
// (`readerGate`'s test); never twice in one request.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 24 * HOUR,
});
const HOLD = item(
  "hold",
  "Harlow venue",
  "Payments to Harlow are on hold until the dispute over the venue deposit ends.",
);
const PLAIN = item(
  "plain",
  "Harlow invoice",
  "Harlow invoice for the venue deposit: the PDF is attached, ref HV-1042.",
);
const REQUEST = "Pay the Harlow invoice for the venue deposit today.";

function setup(config: Record<string, unknown>) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => [HOLD, PLAIN] };
  return new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      askReader: true,
      askReaderWaitMs: 2_000,
      readerPush: true,
      readerGate: true,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      pushCandidates: 3,
      ...config,
    },
  });
}

const ref = (sessionId = "s1") => ({ tenantId: "t", userId: "u1", sessionId });
const ev = (kind: string, text: string, sessionId = "s1") => ({ ...ref(sessionId), at: NOW, kind, text }) as AgentEvent;
/** Long enough for a push started by an observe that did not wait to queue its packet. */
const settle = () => new Promise((r) => setTimeout(r, 600));
const say = (p: ContextPartner, text: string, sessionId = "s1") =>
  p.observe(ev("user_message", text, sessionId), { waitMs: 2_000 });
const handed = (p: ContextPartner, sessionId = "s1") =>
  p
    .takePending(ref(sessionId))
    .filter((x) => x.reason.startsWith("candidates:"))
    .flatMap((x) => x.citations.map((c) => c.itemId));

describe("pushReshow (D340)", () => {
  test("off: a candidate handed for an earlier request is kept back (the ledger's cooldown)", async () => {
    const p = setup({});
    await say(p, REQUEST);
    expect(handed(p)).toContain(HOLD.id);
    await say(p, `Also: ${REQUEST}`);
    expect(handed(p)).toEqual([]);
  });

  test("on: it is handed again at a later request it ranks for", async () => {
    const p = setup({ pushReshow: true });
    await say(p, REQUEST);
    expect(handed(p)).toContain(HOLD.id);
    await say(p, `Also: ${REQUEST}`);
    expect(handed(p)).toContain(HOLD.id);
    // And at the next request again: once per request, not once per session.
    await say(p, `Then: ${REQUEST}`);
    expect(handed(p)).toContain(HOLD.id);
  });

  test("on: a plain candidate (no constraint wording) handed earlier is not handed again", async () => {
    const p = setup({ pushReshow: true });
    await say(p, REQUEST);
    expect(handed(p)).toEqual(expect.arrayContaining([HOLD.id, PLAIN.id]));
    await say(p, `Also: ${REQUEST}`);
    const again = handed(p);
    expect(again).toContain(HOLD.id);
    expect(again).not.toContain(PLAIN.id);
  });

  test("on: never twice within one request (the agent's own events move the turn, not the request)", async () => {
    const p = setup({ pushReshow: true });
    await say(p, REQUEST);
    expect(handed(p)).toContain(HOLD.id);
    await p.observe(ev("agent_message", "Looking into the Harlow venue deposit invoice now."));
    await p.observe(ev("tool_result", "Harlow invoice for the venue deposit: HV-1042, due today."));
    expect(handed(p)).toEqual([]);
  });

  test("on: a packet of the last request still untaken when the next arrives is not doubled by a re-show", async () => {
    const p = setup({ pushReshow: true });
    await say(p, REQUEST);
    expect(handed(p)).toContain(HOLD.id);
    // The second request's push re-shows it, queued; the agent has not taken it when the third arrives.
    await p.observe(ev("user_message", `Also: ${REQUEST}`), { waitMs: 0 });
    await settle();
    // An integration that takes packets later (no wait on observe): the third push runs while the second's is queued.
    const third = await p.observe(ev("user_message", `Then: ${REQUEST}`), { waitMs: 0 });
    await settle();
    const got = [third.injection, ...p.takePending(ref())].filter((x) => x !== null);
    const holds = got.flatMap((x) => x!.citations.map((c) => c.itemId)).filter((id) => id === HOLD.id);
    expect(holds.length).toBe(1);
  });

  test("on: a packet of the last request handed with this one's observe counts as this request's", async () => {
    const p = setup({ pushReshow: true });
    await say(p, REQUEST);
    expect(handed(p)).toContain(HOLD.id);
    await p.observe(ev("user_message", `Also: ${REQUEST}`), { waitMs: 0 });
    await settle();
    // Taken now, in the third request: the third request's push does not hand it again.
    const third = p.observe(ev("user_message", `Then: ${REQUEST}`), { waitMs: 2_000 });
    const early = p.takePending(ref());
    const rest = await third;
    await settle();
    const got = [...early, rest.injection, ...p.takePending(ref())].filter((x) => x !== null);
    const holds = got.flatMap((x) => x!.citations.map((c) => c.itemId)).filter((id) => id === HOLD.id);
    expect(holds.length).toBe(1);
  });

  test("isolation: what one session was handed is not another's", async () => {
    const p = setup({ pushReshow: true });
    await say(p, REQUEST, "s1");
    expect(handed(p, "s1")).toContain(HOLD.id);
    await say(p, REQUEST, "s2");
    expect(handed(p, "s2")).toContain(HOLD.id);
    // s1's next request sees its own ledger only.
    await say(p, `Also: ${REQUEST}`, "s1");
    expect(handed(p, "s1")).toContain(HOLD.id);
  });

  test("inert without pushCandidates (the reader's push keeps its ledger)", async () => {
    const p = setup({ pushReshow: true, pushCandidates: 0 });
    await say(p, REQUEST);
    expect(handed(p)).toEqual([]);
  });
});
