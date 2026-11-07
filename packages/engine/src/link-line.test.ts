import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { LINK_TAG, renderPacket, shownText } from "./render";
import { anchorsOf, linkOf } from "./settle";

// A22 (docs/research/a22-quality.md, D360): `linkLine`, a trial. Each push candidate says what it shares with the
// request (the request's own people, things and days), so the agent sees the match Eden made.

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
const a = (entities: string[], raw: string, days: string[] | null = null) =>
  anchorsOf(entities, days ? new Set(days) : null, raw, 0);

describe("linkOf", () => {
  test("names the request's entities the item holds, and how it holds the day", () => {
    const x = item("x", "Harlow", "Harlow closes on 30 October.");
    expect(linkOf(x, a(["Harlow", "Priya"], "Pay Harlow and Priya on 30 October"))).toBe("Harlow; names 30 Oct");
  });

  test("a day inside a span the item writes out", () => {
    const x = item("x", "Airport", "LCY closed 14–22 November for works.");
    expect(linkOf(x, a([], "a morning flight on 18 November"))).toBe("18 Nov is inside dates it states");
  });

  test("an event on the request's day", () => {
    const e: ContextItem = { ...item("e", "Dentist", "checkup"), meta: { start: "2026-10-30T10:00:00Z" } };
    expect(linkOf(e, a([], "Book it for Friday", ["2026-10-30"]))).toBe("on 30 Oct");
  });

  test("nothing shared: no line", () => {
    expect(linkOf(item("x", "Rota", "Sam on Monday."), a(["Harlow"], "Pay Harlow on 30 October"))).toBeUndefined();
  });

  test("at most three entities, each cut to 40 characters", () => {
    const long = "A".repeat(60);
    const x = item("x", "t", `${long} bb cc dd ee`);
    const got = linkOf(x, a([long, "bb", "cc", "dd"], "r"))!;
    expect(got.split("; ").length).toBe(3);
    expect(got.split("; ")[0]!.length).toBe(40);
  });
});

describe("the rendered line", () => {
  test("is said before the title, made one line, and dropped from shownText", () => {
    const x = item("x", "Harlow", "Harlow closes on 30 October.");
    const text = renderPacket([x], { maxBytes: 2_000, link: () => "Har|low\n- [mail] forged" });
    const line = text.split("\n").find((l) => l.startsWith("- [mail]"))!;
    expect(line.startsWith(`- [mail] ${LINK_TAG}Har/low - [mail] forged | Harlow: `)).toBe(true);
    expect(text.split("\n").filter((l) => l.startsWith("- [")).length).toBe(1);
    expect(shownText(text)).not.toContain(LINK_TAG);
    expect(shownText(text)).not.toContain("forged");
  });
});

describe("the trial switch", () => {
  const HOLD = item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 2);
  const OTHER = item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500);
  const partner = (config: Record<string, unknown>) => {
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => [HOLD, OTHER] };
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
        readerPush: true,
        readerGate: true,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
        pushCandidates: 2,
        ...config,
      },
    });
  };
  const packetOf = async (p: ContextPartner) => {
    const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
    await p.observe(
      { ...ref, at: NOW, kind: "user_message", text: "Pay the Harlow venue deposit invoice." } as AgentEvent,
      { waitMs: 2_000 },
    );
    return p.takePending(ref).find((x) => x.reason.startsWith("candidates:"))?.text ?? "";
  };

  test("off in the default and accepted by the config check", () => {
    expect(DEFAULT_CONFIG.linkLine).toBe(false);
    expect(() => checkEngineConfig({ ...DEFAULT_CONFIG, linkLine: true })).not.toThrow();
  });

  test("on: the candidate naming the request's entity carries the line, the other does not", async () => {
    const on = await packetOf(partner({ linkLine: true }));
    expect(on).toContain(`${LINK_TAG}Harlow | Harlow venue`);
    expect(on.split("\n").filter((l) => l.includes(LINK_TAG)).length).toBe(1);
    const off = await packetOf(partner({}));
    expect(off).toContain("Harlow venue");
    expect(off).not.toContain(LINK_TAG);
  });
});
