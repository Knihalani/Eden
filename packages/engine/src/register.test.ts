import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { amountsOf, conflictOf, constraintOf, judge, sameWord, wordsOf, type Act, type Naming } from "./register";

const now = Date.parse("2026-10-27T09:00:00Z");
const item = (title: string, text: string, meta?: Record<string, string>): ContextItem => ({
  id: `x:${title}`,
  sourceId: "x",
  ref: title,
  title,
  text,
  ...(meta ? { meta } : {}),
});
const act = (raw: string, days: string[], words = wordsOf(raw)): Act => ({ days, amounts: amountsOf(raw), words });
/** The register's verdict on one item for one request, on the given days. */
const verdict = (it: ContextItem, raw: string, days: string[], naming: Naming = null) => {
  const c = constraintOf(it, now);
  return c ? judge(c, act(raw, days), naming) : null;
};

describe("the register: what an item states", () => {
  test("a prohibition with a date range holds on those days only", () => {
    const freeze = item("Change freeze", "No production changes from Wednesday 28 October to Tuesday 3 November.");
    const c = constraintOf(freeze, now)!;
    expect(c.rules[0]!.spans).toEqual([{ from: "2026-10-28", to: "2026-11-03" }]);
    expect(conflictOf(c, act("ship the release", ["2026-10-29"]))).toBe("span");
    // The same freeze another week (the decoy) does not bind Thursday.
    const later = constraintOf(item("Change freeze", "No production changes from 16 November to 20 November."), now)!;
    expect(conflictOf(later, act("ship the release", ["2026-10-29"]))).toBeNull();
  });

  test("an undated sentence takes the dates of the one before or after it", () => {
    const jury = item("DM", "I've been called for jury service on Thu 29 Oct. Completely offline all day.");
    expect(constraintOf(jury, now)!.rules[0]!.spans).toEqual([{ from: "2026-10-29", to: "2026-10-29" }]);
  });

  test("a cap binds an amount of its unit above it, and only above it", () => {
    const cap = item("Policy for Q4 renewals", "Discounts above 10% need CFO sign-off before they are offered.");
    expect(verdict(cap, "Offer Globex 15% off on their renewal", [])!.conflict).toBe("limit");
    expect(verdict(cap, "Offer Globex 8% off on their renewal", [])!.conflict).toBeNull();
    const upTo = item("Policy for Q4 renewals", "Sales can offer discounts of up to 20% without further approval.");
    expect(verdict(upTo, "Offer Globex 15% off on their renewal", [])!.conflict).toBeNull();
    // A per-person amount is spent once per person: 14 covers at £85 is £1,190, over a £750 cap.
    const policy = item("Expenses policy", "Any event whose total cost exceeds £750 must be pre-approved.");
    expect(verdict(policy, "Book dinner for 14 people at £85 a head", [])!.conflict).toBe("limit");
    expect(verdict(policy, "Book dinner for 4 people at £85 a head", [])!.conflict).toBeNull();
  });

  test("a deadline binds a day after it; an expiry is a standing state", () => {
    const rfp = item(
      "Tender",
      "Responses must be uploaded by 17:00 UK time on Monday 26 October. Late ones are refused.",
    );
    expect(verdict(rfp, "Submit our tender response", ["2026-10-30"])!.conflict).toBe("passed");
    expect(verdict(rfp, "Submit our tender response", ["2026-10-25"])!.conflict).toBeNull();
    const nda = item("NDA", "The mutual NDA expired on 30 September 2026.");
    expect(verdict(nda, "send the roadmap", ["2026-10-27"])!.conflict).toBe("state");
  });

  test("a rule or state that is said to no longer hold is no rule", () => {
    expect(
      constraintOf(item("#legal", "The litigation hold on Globex records was lifted on 20 October."), now),
    ).toBeNull();
    // The next sentence about the same thing: "expired … ; the renewed report … was accepted".
    const renewed = item(
      "Risk register",
      "Their report expired 30 Sep 2026; the renewed report arrived 2 Oct and was accepted.",
    );
    expect(constraintOf(renewed, now)).toBeNull();
    // A condition is not a counter ("until the MSA is countersigned"), nor a requirement ("must be pre-approved").
    const hold = item("#legal", "Do not commit delivery dates to Umbrella Health until the MSA is countersigned.");
    expect(constraintOf(hold, now)).not.toBeNull();
    // A counter about something else in the next sentence leaves the rule standing.
    const ids = item("IDs", "Passport expires 2 Nov 2026. Driving licence: renewed 2024.");
    expect(constraintOf(ids, now)).not.toBeNull();
    // Negated: "not blocked".
    expect(constraintOf(item("SSO", "The release is not blocked by anything."), now)).toBeNull();
  });

  test("a footer's boilerplate is no rule; headers and quotes are not read", () => {
    const mail = item(
      "Q3 numbers",
      "From: Hana Kim <h@x.example>\nAttached the sheet. -- Hana Kim\nCONFIDENTIALITY NOTICE: this email is confidential and may not be shared.",
    );
    expect(constraintOf(mail, now)).toBeNull();
  });

  test("a lasting state's past date is when it began; a passing one's is that day", () => {
    const left = constraintOf(item("Contact", "Status: no longer at Soylent Foods as of 16 Oct 2026."), now)!;
    expect(conflictOf(left, act("email the plan", ["2026-10-27"]))).toBe("state");
    const jury = constraintOf(item("DM", "Offline all day on Thu 29 Oct."), now)!;
    expect(conflictOf(jury, act("set up the interview", ["2026-10-30"]))).toBeNull();
  });

  test("words are one word's forms when they share five letters, or a four-letter word starts the other", () => {
    expect(sameWord("renewal", "renewals")).toBe(true);
    expect(sameWord("sign", "signature")).toBe(true);
    expect(sameWord("plan", "planet")).toBe(true);
    expect(sameWord("dentist", "dental")).toBe(false);
    expect(wordsOf("Please send the Q3 report to Rose on Friday")).toEqual(["send", "report", "rose"]);
  });

  test("the scans stay linear on hostile text", () => {
    const hostile = [
      `1${" ".repeat(32_000)}`,
      `${"12 ".repeat(8_000)}`,
      `no ${"x ".repeat(16_000)}`,
      `${"above ".repeat(4_000)}£1`,
      `${"until when ".repeat(3_000)}approved`,
      `on ${"a".repeat(16_000)} wrote:`,
    ];
    for (const text of hostile) {
      const t0 = performance.now();
      constraintOf(item("t", text), now);
      amountsOf(text);
      wordsOf(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe("the register's verdict: what binds with no model", () => {
  test("a dated conflict binds with a shared subject word or a name; with neither it only earns a seat", () => {
    const freeze = item("Change freeze", "No production changes from 28 October to 3 November.");
    expect(verdict(freeze, "deploy the production release", ["2026-10-29"])!.binds).toBe(true);
    const seat = verdict(freeze, "schedule the billing release", ["2026-10-29"])!;
    expect(seat.binds).toBe(false);
    expect(seat.touches).toBe(true);
    expect(seat.rank).toBeGreaterThan(0);
  });

  test("a standing state binds what it is about, not every request that mentions a name in it", () => {
    const left = item("Rebecca Stone (Soylent Foods)", "Status: no longer at Soylent Foods; the old address bounces.");
    expect(verdict(left, "email Rebecca the plan", ["2026-10-27"], "subject")!.binds).toBe(true);
    expect(verdict(left, "email Rebecca the plan", ["2026-10-27"], null)!.binds).toBe(false);
    // A thing's state, merely mentioning the name, needs a word of the request too.
    const held = item("INV-4383 on hold", "Aperture Labs invoice is on hold pending a credit note.");
    expect(verdict(held, "get their engineer VPN access to staging", ["2026-10-27"], "named")!.binds).toBe(false);
    expect(verdict(held, "pay the outstanding invoice", ["2026-10-27"], "named")!.binds).toBe(true);
    // A person's own state binds whoever it names ("severe nut allergy").
    const notes = item("People notes", "Sam Patel: severe nut allergy, always check gifts.");
    expect(verdict(notes, "order chocolates for Sam", ["2026-10-27"], "named")!.binds).toBe(true);
  });
});

describe("the register in the cache (isolation)", () => {
  test("each user's register holds only their items, read once, dropped with them", () => {
    const cache = new ItemCache();
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t", userId: "b" };
    cache.put(a, [item("Change freeze", "No production changes from 28 October to 3 November.")], now);
    cache.put(b, [item("Lunch", "Pizza on Friday.")], now);
    expect(cache.register(a, now).map((r) => r.hit.item.title)).toEqual(["Change freeze"]);
    expect(cache.register(b, now)).toEqual([]);
    expect(cache.register({ tenantId: "u", userId: "a" }, now)).toEqual([]);
    cache.forget(a);
    expect(cache.register(a, now)).toEqual([]);
  });

  test("a sweep goes a few steps per lookup, per user, and starts again only after its interval", () => {
    const cache = new ItemCache();
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t", userId: "b" };
    expect(cache.sweepSteps(a, 2, 5, 1_000, 0)).toEqual([0, 1]);
    expect(cache.sweepSteps(b, 2, 5, 1_000, 0)).toEqual([0, 1]);
    expect(cache.sweepSteps(a, 2, 5, 1_000, 10)).toEqual([2, 3]);
    expect(cache.sweepSteps(a, 2, 5, 1_000, 20)).toEqual([4]);
    expect(cache.sweepSteps(a, 2, 5, 1_000, 30)).toEqual([]);
    expect(cache.sweepSteps(a, 2, 5, 1_000, 1_030)).toEqual([0, 1]);
  });
});

describe("the register in the engine (config.register)", () => {
  const scope = { tenantId: "t", userId: "u" };
  // The request's own search finds the policy (a word they share); only its cap says it matters.
  const text = "Offer Globex 15% off so we can close their Q4 renewal this week.";
  const policy = (cap: string) =>
    new StaticSource("slack", "Slack", [
      { ref: "p1", title: "#finance-approvals", text: `Policy for Q4 renewals: discounts ${cap} need CFO sign-off.` },
    ]);
  const run = async (source: Source, config: Record<string, unknown>, model: FakeModel | null = null) => {
    const p = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      now: () => now,
      // Nothing is sure on its words alone, and the plain fallback is off: only the register can deliver.
      config: { probes: true, probeGraceMs: 1_000, confidentScore: 99, fallbackMatchedTerms: 0, ...config },
    });
    const r = await p.observe({ ...scope, sessionId: "s", at: now, kind: "user_message", text } as AgentEvent, {
      waitMs: 1_000,
    });
    return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...scope, sessionId: "s" })].flatMap((i) =>
      i.citations.map((c) => `${c.itemId} ${i.reason.split(":")[0]}`),
    );
  };

  test("with no model, an amount over a stated cap is delivered; under it, or with the flag off, nothing is", async () => {
    expect(await run(policy("above 10%"), { register: true })).toEqual(["slack:p1 grounded-rule"]);
    expect(await run(policy("above 20%"), { register: true })).toEqual([]);
    expect(await run(policy("above 10%"), {})).toEqual([]);
  });

  test("with a judge, a rule the request conflicts with is among its candidates", async () => {
    const model = new FakeModel(() => '{"pick": []}');
    await run(policy("above 10%"), { register: true }, model);
    expect(
      model.calls
        .at(-1)!
        .messages.map((m) => m.content)
        .join("\n"),
    ).toContain("discounts above 10%");
  });

  test("a sweep finds a rule the request shares no word with; it then earns a judge's seat", async () => {
    const freeze = new StaticSource("calendar", "Calendar", [
      { ref: "f1", title: "Change freeze", text: "No production changes from 28 October to 3 November." },
    ]);
    const searched: string[] = [];
    const counted: Source = {
      id: freeze.id,
      kind: "test",
      description: freeze.description,
      search: (q) => (searched.push(q.text), freeze.search(q)),
    };
    const model = new FakeModel(() => '{"pick": []}');
    const p = new ContextPartner({
      sources: async () => [counted],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      now: () => now,
      config: { probes: true, probeGraceMs: 1_000, register: true, registerSweepMs: 86_400_000, registerSweepCalls: 6 },
    });
    const say = async (sessionId: string, raw: string) => {
      await p.observe({ ...scope, sessionId, at: now, kind: "user_message", text: raw } as AgentEvent, {
        waitMs: 1_000,
      });
      await new Promise((r) => setTimeout(r, 20));
    };
    await say("s1", "Schedule the billing release for Thursday 29 October at 2pm");
    expect(searched).toContain("freeze");
    await say("s2", "Schedule the billing release for Thursday 29 October at 2pm");
    expect(
      model.calls
        .at(-1)!
        .messages.map((m) => m.content)
        .join("\n"),
    ).toContain("No production changes");
  });
});
