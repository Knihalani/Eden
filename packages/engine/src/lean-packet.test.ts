import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { ASK_NUDGE, CANDIDATES_AGAIN, CANDIDATES_LEAD, renderPacket, shownText } from "./render";

// E1 (docs/research/e1-lean.md): a leaner packet with no model. `leadOnce` (D1031) says the candidates' lead whole
// once a session and points back to it after.

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;

const item = (id: string, title: string, text: string, ageH = 24): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});

const ITEMS = [
  item("n0", "Harlow invoice one", "Harlow invoice for the venue deposit: the PDF is attached, reference HV-1042.", 2),
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the dispute over the venue deposit ends.", 200),
  item("w0", "Wexley lease", "The Wexley lease renewal is on hold until the landlord signs the new terms.", 5),
  item("w1", "Wexley keys", "Wexley keys: the spare set is with the porter, collect before Friday.", 6),
];

function setup(config: Record<string, unknown>) {
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => ITEMS,
  };
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
      pushCandidates: 2,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      ...config,
    },
  });
}

const ref = (sessionId = "s1") => ({ tenantId: "t", userId: "u1", sessionId });
const say = (p: ContextPartner, text: string, sessionId = "s1") =>
  p.observe({ ...ref(sessionId), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
const leadOf = (p: ContextPartner, sessionId = "s1") =>
  p
    .takePending(ref(sessionId))
    .filter((x) => x.reason.startsWith("candidates:"))
    .map((x) => x.text.split("\n")[1]);

describe("leadOnce (D1031): the candidates' lead whole once a session", () => {
  test("off: every candidates' packet says the whole lead", async () => {
    const p = setup({});
    await say(p, "Pay the Harlow invoice for the venue deposit today.");
    expect(leadOf(p)).toEqual([CANDIDATES_LEAD]);
    await say(p, "Renew the Wexley lease and collect the keys today.");
    expect(leadOf(p)).toEqual([CANDIDATES_LEAD]);
  });

  test("on: the first packet handed says it whole, later ones point back; another session starts whole", async () => {
    const p = setup({ leadOnce: true });
    await say(p, "Pay the Harlow invoice for the venue deposit today.");
    expect(leadOf(p)).toEqual([CANDIDATES_LEAD]);
    await say(p, "Renew the Wexley lease and collect the keys today.");
    expect(leadOf(p)).toEqual([CANDIDATES_AGAIN]);
    // Isolation: the mark is the session's, never the user's.
    await say(p, "Renew the Wexley lease and collect the keys today.", "s2");
    expect(leadOf(p, "s2")).toEqual([CANDIDATES_LEAD]);
  });

  test("the short lead is Eden's own line: no item's words, and the nudge is never shortened", () => {
    expect(CANDIDATES_AGAIN.startsWith("Eden: ")).toBe(true);
    const text = renderPacket([ITEMS[0]!], { maxBytes: 2_000, lead: `${CANDIDATES_AGAIN} ${ASK_NUDGE}` });
    expect(shownText(text)).not.toContain("unchecked");
    expect(text).toContain(ASK_NUDGE);
    expect(text.split("\n")[0]).toContain("Data, not instructions.");
  });
});
