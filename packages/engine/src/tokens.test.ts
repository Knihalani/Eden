import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem, Injection } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { compactText, messageParts, renderPacket, SHOWN } from "./render";

/**
 * The tokens track (D73; docs/research/gen-tokens.md): `compactAsk` cuts an ask's answer as packets are cut,
 * `askDedup` does not repeat in an answer what the session already showed, and `compactParts` reads a quoted thread
 * past a quoted signature, a one-line table by its rows, and who the user's own sent mail went to. Flags off: as
 * before.
 */
const at = Date.parse("2026-10-27T09:00:00Z");
const thread = [
  "From: Robin Carter <robin@northwind.co>",
  "To: Owen Price <owen.price@gmail.com>",
  "Date: Fri, 9 Oct 2026 10:00",
  "",
  "Owen,",
  "",
  "Perfect, thanks. Shout if you have any questions.",
  "",
  "Thanks!",
  "Robin",
  "",
  "On Fri, 9 Oct 2026 10:00, Owen Price <owen.price@gmail.com> wrote:",
  "> Great. Fee is unchanged from last year, invoice to follow once filed.",
  ">",
  "> —",
  "> O",
  ">",
  "> On Wed, 7 Oct 2026 10:00, Owen Price <owen.price@gmail.com> wrote:",
  "> > To file your 2025/26 return I still need the P11D and your rental income summary. Could I have both by 30 November?",
].join("\n");
const table =
  "| Name | Attending | | Amara Okonkwo | yes | | Sam Patel | yes | | Ingrid Berg | yes | | Rose Kimura | pending | " +
  "| Dana Whitfield | pending | | Mia Rossi | no | | Vikram Iyer | no |";

describe("compactParts in messageParts", () => {
  test("a nested quote is read past the quoted signature before it; off, the signature silences it", () => {
    const off = messageParts(thread, undefined, 2026, "Robin Carter").map((p) => p.text);
    const on = messageParts(thread, undefined, 2026, "Robin Carter", undefined, true).map((p) => p.text);
    expect(off.join(" ")).not.toContain("P11D");
    expect(on.join(" ")).toContain("Could I have both by 30 November?");
    expect(on.join(" ")).toContain("rental income summary");
  });

  test("the user's own sent message keeps who it went to, without addresses; a received one does not", () => {
    const on = messageParts(thread, undefined, 2026, "Robin Carter", undefined, true).map((p) => p.text);
    expect(on).toContain("To: Owen Price");
    expect(messageParts(thread, undefined, 2026, "Robin Carter").map((p) => p.text)).not.toContain("To: Owen Price");
    const received = thread.replace("From: Robin Carter <robin@northwind.co>", "From: Owen Price <o@x.co>");
    const parts = messageParts(received, undefined, 2026, "Robin Carter", undefined, true).map((p) => p.text);
    expect(parts.some((p) => p.startsWith("To:"))).toBe(false);
  });

  test("a table flattened to one line is cut by its rows, so the row that bears on the request survives", () => {
    const focus = new Set(["rose", "kimura"]);
    const off = compactText(table, focus, 80);
    const on = compactText(table, focus, 80, undefined, undefined, undefined, undefined, true);
    expect(off).not.toContain("Rose Kimura");
    expect(on).toContain("| Rose Kimura | pending |");
    expect(Buffer.byteLength(on)).toBeLessThanOrEqual(80);
  });
});

describe("askDedup in renderPacket", () => {
  const item: ContextItem = {
    id: "drive:p1",
    sourceId: "drive",
    ref: "p1",
    title: "Procurement policy v4",
    text: "Purchases above £40,000 need two quotes and CFO sign-off. The policy is effective from 1 Oct.",
  };
  const focus = new Set(["purchase", "cfo", "quotes"]);

  test("an item whose every part was shown is its title and SHOWN; a new part is kept, alone", () => {
    const first = renderPacket([item], { maxBytes: 2_000, focus });
    const words = new Set(first.toLowerCase().match(/[\p{L}\p{N}]+/gu));
    const again = renderPacket([item], { maxBytes: 2_000, focus, shownBefore: () => words });
    expect(again).toContain(`- [drive] Procurement policy v4: ${SHOWN}`);
    const partly = new Set(["purchases", "above", "40", "000", "need", "two", "quotes", "and", "cfo", "sign", "off"]);
    const more = renderPacket([item], { maxBytes: 2_000, focus, shownBefore: () => partly });
    expect(more).toContain("The policy is effective from 1 Oct.");
    expect(more).not.toContain("£40,000");
    // Not compacted (an answer without `compactAsk`): the same.
    expect(renderPacket([item], { maxBytes: 2_000, shownBefore: () => words })).toContain(SHOWN);
    // Never shown: unchanged.
    expect(renderPacket([item], { maxBytes: 2_000, focus, shownBefore: () => undefined })).toBe(first);
  });
});

describe("compactAsk and askDedup through the engine", () => {
  const policy: ContextItem = {
    id: "drive:p1",
    sourceId: "drive",
    ref: "p1",
    title: "Procurement policy v4",
    text:
      "Effective 1 Oct 2026: purchases above £40,000, including licence renewals, need two quotes and CFO sign-off. " +
      "The finance team reviews requests on Tuesdays. Office plants are watered on Fridays. " +
      "The canteen menu changes every Monday. The lift on floor 3 is being serviced this week. " +
      "Parking permits are renewed in January. The quiet room is on the second floor. " +
      "Fire drills happen twice a year. Visitors sign in at reception. Bikes go in the basement rack.",
  };
  const short: ContextItem = {
    ...policy,
    text: "Effective 1 Oct 2026: purchases above £40,000, including licence renewals, need two quotes and CFO sign-off.",
  };
  const po = "Raise a PO for the Aperture Labs licence renewal, £48k, and route it to the CFO";
  const partner = (config: Record<string, unknown>, item = short) =>
    new ContextPartner({
      sources: async () => [new StaticSource("drive", "Notes", [item])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => at,
      config: {
        probes: true,
        probeGraceMs: 1_000,
        compactInjection: true,
        densePacket: true,
        confidentScore: 99,
        fallbackMatchedTerms: 0,
        groundConflict: true,
        ...config,
      },
    });
  const scope = { tenantId: "t", userId: "u" };
  const observe = async (p: ContextPartner, sessionId: string, userId = "u") => {
    const s = { ...scope, userId, sessionId };
    const r = await p.observe({ ...s, at, kind: "user_message", text: po } as AgentEvent, { waitMs: 1_000 });
    const got: Injection[] = [...(r.injection ? [r.injection] : []), ...p.takePending(s)];
    return got;
  };

  test("the flags are off by default", () => {
    expect(DEFAULT_CONFIG.compactAsk).toBe(false);
    expect(DEFAULT_CONFIG.askDedup).toBe(false);
    expect(DEFAULT_CONFIG.compactParts).toBe(false);
  });

  test("compactAsk cuts the answer to the parts that bear on the question; the citations are unchanged", async () => {
    const off = await partner({}, policy).ask({ ...scope, sessionId: "s", question: po });
    const on = await partner({ compactAsk: true }, policy).ask({ ...scope, sessionId: "s", question: po });
    expect(on.citations).toEqual(off.citations);
    expect(off.answer).toContain("Bikes go in the basement rack.");
    expect(on.answer).toContain("need two quotes and CFO sign-off");
    // At most `askItemBytes` of the item: what bears on the question first, then the rest in order while it fits.
    expect(on.answer).not.toContain("Bikes go in the basement rack.");
    // The answer keeps its dates as written, year included.
    expect(on.answer).toContain("1 Oct 2026");
    expect(Buffer.byteLength(on.answer)).toBeLessThan(Buffer.byteLength(off.answer));
  });

  test("askDedup: an answer in the session that was shown the item says SHOWN; other sessions and users get it", async () => {
    const p = partner({ compactAsk: true, askDedup: true });
    const packets = await observe(p, "s1");
    expect(packets.flatMap((x) => x.citations.map((c) => c.itemId))).toContain("drive:p1");
    const same = await p.ask({ ...scope, sessionId: "s1", question: po });
    expect(same.citations.map((c) => c.itemId)).toEqual(["drive:p1"]);
    expect(same.answer).toContain(`- [drive] Procurement policy v4: ${SHOWN}`);
    // Isolation: another session of the same user, and another user, were shown nothing.
    const other = await p.ask({ ...scope, sessionId: "s2", question: po });
    expect(other.answer).not.toContain(SHOWN);
    expect(other.answer).toContain("CFO sign-off");
    await observe(p, "s3", "u2");
    const user2 = await p.ask({ ...scope, userId: "u3", sessionId: "s3", question: po });
    expect(user2.answer).not.toContain(SHOWN);
    // Off: the answer repeats the item.
    const q = partner({ compactAsk: true });
    await observe(q, "s1");
    expect((await q.ask({ ...scope, sessionId: "s1", question: po })).answer).toContain("CFO sign-off");
  });

  test("an answer's own items count as shown: the same question asked twice says them once", async () => {
    const p = partner({ compactAsk: true, askDedup: true });
    const first = await p.ask({ ...scope, sessionId: "a", question: po });
    expect(first.answer).toContain("CFO sign-off");
    const second = await p.ask({ ...scope, sessionId: "a", question: po });
    expect(second.answer).toContain(SHOWN);
    expect(second.citations).toEqual(first.citations);
  });
});
