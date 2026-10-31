import { describe, expect, spyOn, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { Vocab } from "@eden/primitives";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { accounts, actionKey, actionText, domainsOf, setsTime, structuralTie, writtenDates } from "./firewall";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";

// Tuesday 27 October 2026, 09:00 UTC: the simulation's fixed "now".
const NOW = Date.UTC(2026, 9, 27, 9);

describe("firewall: reading a tool call", () => {
  test("ISO dates are written out as the engine's day readers read them", () => {
    expect(writtenDates("on 2026-10-29T19:00")).toBe("on Thursday 29 October 2026 at 19:00");
    expect(writtenDates("2026-10-31")).toBe("Saturday 31 October 2026");
    expect(writtenDates("2026-10-29 19:00:00Z")).toBe("Thursday 29 October 2026 at 19:00");
    // Not a date: left as it is.
    expect(writtenDates("2026-13-40 and PO-2026-11")).toBe("2026-13-40 and PO-2026-11");
  });

  test("a call reads as its name and arguments; a date and a time given apart are joined", () => {
    const text = actionText("book_table", {
      restaurant: "Dishoom",
      date: "2026-10-31",
      time: "19:30",
      party_size: 2,
      guests: ["Leila Haddad"],
    });
    expect(text).toContain("book table");
    expect(text).toContain("restaurant Dishoom");
    expect(text).toContain("guests Leila Haddad");
    expect(text).toContain("on Saturday 31 October 2026 at 19:30");
  });

  test("free text is left out of the cue but read for whether the call accounts for a finding", () => {
    const input = { to: ["Sam"], subject: "Board deck", body: "Hi Sam, could you review the deck by Friday?" };
    expect(actionText("send_email", input, { prose: false })).not.toContain("review the deck");
    expect(actionText("send_email", input)).toContain("review the deck");
  });

  test("a call is bounded however large its arguments", () => {
    const text = actionText("do_action", { kind: "x", details: "word ".repeat(100_000) });
    expect(text.length).toBeLessThanOrEqual(2_100);
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    expect(actionText("x", deep)).not.toContain("too deep");
  });

  test("a call's key ignores argument order and tells calls apart", () => {
    expect(actionKey("pay", { a: 1, b: [2, 3] })).toBe(actionKey("pay", { b: [2, 3], a: 1 }));
    expect(actionKey("pay", { a: 1 })).not.toBe(actionKey("pay", { a: 2 }));
    expect(actionKey("pay", { a: 1 })).not.toBe(actionKey("send", { a: 1 }));
  });

  test("only a call with a start commits the user at a time", () => {
    expect(setsTime({ start: "2026-10-29T19:00" })).toBe(true);
    expect(setsTime({ date: "2026-10-31", time: "19:30" })).toBe(true);
    expect(setsTime({ to: ["Ruth"], body: "Saturday at 7pm" })).toBe(false);
    expect(setsTime({ start: "" })).toBe(false);
  });
});

describe("firewall: when a call accounts for a finding", () => {
  test("its own words name the decisive fact, which the request did not", () => {
    const allergy = "Jamie Fox: severe shellfish allergy, carries an EpiPen.";
    expect(
      accounts(allergy, "book table notes one guest has a shellfish allergy", "Book seafood for me and Jamie"),
    ).toBe(true);
    const leave = "Sam Patel (Legal) out of office Monday 26 October to Friday 6 November.";
    expect(accounts(leave, "send email to Kofi: Sam is on leave until 6 November", "get legal to sign off")).toBe(true);
  });

  test("naming the same invoice or person is not accounting for it", () => {
    const paid = "Payment of £11,500 to Aperture Labs for INV-4006 was sent on Tuesday 27 Oct.";
    expect(
      accounts(paid, "do action approve invoice details Approve INV-4006 for £11,500", "approve the invoice"),
    ).toBe(false);
  });

  test("a word the request itself used is not the agent's knowing", () => {
    const freeze = "Change freeze: no production changes from 28 October to 3 November.";
    expect(accounts(freeze, "deploy billing; freeze exception requested", "deploy despite the freeze")).toBe(false);
  });
});

describe("firewall: ties the words cannot fake", () => {
  const frame = (days: string[], amounts: { unit: string; value: number }[] = []) => ({ days, named: true, amounts });
  test("a span over the day the call acts on", () => {
    const item = "Change freeze. No production changes from Wednesday 28 October to Tuesday 3 November.";
    expect(structuralTie(item, frame(["2026-10-29"]), [], NOW)).toBe(true);
    expect(structuralTie(item, frame(["2026-11-12"]), [], NOW)).toBe(false);
  });

  test("an expiry between now and the day the call acts on", () => {
    const item = "Robin's passport: no. 5481, issued 14 Nov 2016, expires 2 Nov.";
    expect(structuralTie(item, frame(["2026-11-20"]), [], NOW)).toBe(true);
    expect(structuralTie(item, frame(["2026-10-30"]), [], NOW)).toBe(false);
  });

  test("a standing constraint about someone the call names, not about anyone", () => {
    const item = "Jamie Fox: severe nut allergy, always check gifts and restaurants.";
    const gift = "order chocolates recipient Jamie Fox";
    expect(structuralTie(item, { days: [], named: false, amounts: [] }, ["jamie fox"], NOW, gift)).toBe(true);
    expect(structuralTie(item, { days: [], named: false, amounts: [] }, ["leila haddad"], NOW, gift)).toBe(false);
  });

  test("a limit below an amount the call commits, in its unit", () => {
    const item = "Reminder that travel over £500 needs pre-approval from now on.";
    const travel = new Set(["travel", "flights"]);
    const pounds = (value: number, ties = travel) => ({
      ...frame(["2026-10-27"], [{ unit: "£", value }]),
      wordTies: ties,
    });
    expect(structuralTie(item, pounds(48_000), [], NOW)).toBe(true);
    expect(structuralTie(item, pounds(300), [], NOW)).toBe(false);
    expect(
      structuralTie(item, { ...frame(["2026-10-27"], [{ unit: "%", value: 15 }]), wordTies: travel }, [], NOW),
    ).toBe(false);
    // A limit on something else the call does not do: travel, for a follow-up on an £80,000 deal.
    expect(structuralTie(item, pounds(80_000, new Set(["follow-up", "deal"])), [], NOW)).toBe(false);
  });

  test("a prohibition, a move or a thing done that binds a party the call names, by name or by address", () => {
    const none = { days: [], named: false, amounts: [] };
    const sharing = "Their access is suspended and nobody should share files with anyone at Tyrell Bio.";
    expect(structuralTie(sharing, none, domainsOf("share with aiko.tanaka@tyrellbio.com"), NOW)).toBe(true);
    expect(structuralTie(sharing, none, domainsOf("share with aiko@initech.io"), NOW)).toBe(false);
    const moved = "Hi Robin, could we push tomorrow's call to 4:30pm? Thanks, Christopher Hall";
    expect(structuralTie(moved, none, ["christopher hall"], NOW)).toBe(true);
    const fine = "Hi Robin, all good for 3pm tomorrow, talk then. Thanks, Christopher Hall";
    expect(structuralTie(fine, none, ["christopher hall"], NOW)).toBe(false);
  });

  test("a diet binds a food or gift call only; a cut-off 'please do not' binds nothing", () => {
    const none = { days: [], named: false, amounts: [] };
    const veggie = "Sam Patel: I'm vegetarian, so somewhere with good veggie options please.";
    expect(structuralTie(veggie, none, ["sam patel"], NOW, "book table restaurant guests Sam Patel")).toBe(true);
    expect(structuralTie(veggie, none, ["sam patel"], NOW, "send email to Sam Patel: feed the cat?")).toBe(false);
    const notice = "Sam Patel commented in Hiring tracker. Please do not";
    expect(structuralTie(notice, none, ["sam patel"], NOW)).toBe(false);
  });

  test("a thing done on the day is no constraint on it", () => {
    const item = "Payment of £6,500 to Cyberdyne for INV-8490 was sent on Tuesday 27 October.";
    expect(structuralTie(item, frame(["2026-10-27"]), [], NOW)).toBe(false);
  });

  test("a name and a blocking word alone are no tie", () => {
    const item = "Leila: Friday at 19:30 works. I can't do anything before 19:00 that day.";
    expect(structuralTie(item, frame(["2026-10-31"]), ["leila"], NOW)).toBe(false);
  });
});

// ── the partner's `checkAction` ──

const calendar = new StaticSource("calendar", "The user's calendar", [
  {
    ref: "evt-pe",
    title: "Parents' evening, Highbury Primary",
    text: "Thursday 29 October 2026, 18:30-20:30. Hall B. Bring the reading log.",
    meta: { start: "2026-10-29T18:30:00Z" },
  },
]);
const mail = new StaticSource("gmail", "The user's mail", [
  {
    ref: "m-paid",
    title: "Payment sent: INV-4821 to Tyrell Bio",
    text: "Your bank transfer of £4,200.00 to Tyrell Bio for invoice INV-4821 was sent on Monday 26 October.",
  },
]);

function partner(config: Record<string, unknown>, sources: Source[] = [calendar, mail]) {
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { probes: true, groundConflict: true, ...config },
    onTrace: (t) => traces.push(t),
  });
  return { p, traces };
}

const user = (userId: string, sessionId = "s1") => ({ tenantId: "t1", userId, sessionId });
const ev = (who: ReturnType<typeof user>, e: Record<string, unknown>) => ({ ...who, at: NOW, ...e }) as AgentEvent;

describe("checkAction", () => {
  test("off by default: every call proceeds and no session is opened", async () => {
    const { p } = partner({});
    const r = await p.checkAction(ev(user("u1"), { kind: "tool_call", tool: "send_payment", input: { amount: "1" } }));
    expect(r).toMatchObject({ verdict: "proceed", finding: null, reason: "off" });
    expect(p.sessionCount).toBe(0);
  });

  test("a booking at a time the calendar holds is a finding, as data; the same call again proceeds", async () => {
    const { p, traces } = partner({ actionCheck: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Set up dinner with Jamie Fox on Thursday 29 October at 19:00." }),
      { waitMs: 1_000 },
    );
    const call = ev(u, {
      kind: "tool_call",
      tool: "schedule_event",
      input: { title: "Dinner with Jamie Fox", start: "2026-10-29T19:00", attendees: ["Jamie Fox"] },
    });
    const r = await p.checkAction(call);
    expect(r.verdict).toBe("finding");
    expect(r.finding?.citations.map((c) => c.itemId)).toContain("calendar:evt-pe");
    // The finding is Eden's usual data envelope: the item, no instruction to the agent.
    expect(r.finding?.text.startsWith("<context")).toBe(true);
    expect(r.finding?.text).not.toMatch(/\b(do not|don't|you must|stop|call again)\b/i);
    // No model and no source call.
    const t = traces.find((x) => x.reason.startsWith("action-"))!;
    expect(t.modelCalls + t.sourceCalls).toBe(0);
    const again = await p.checkAction(call);
    expect(again).toMatchObject({ verdict: "proceed", reason: "repeat" });
  });

  test("a call at another time than the clash, or one that books nothing, proceeds", async () => {
    const { p } = partner({ actionCheck: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Set up dinner with Jamie Fox on Thursday 29 October at 19:00." }),
      { waitMs: 1_000 },
    );
    const later = await p.checkAction(
      ev(u, { kind: "tool_call", tool: "schedule_event", input: { title: "Dinner", start: "2026-11-12T19:00" } }),
    );
    expect(later.verdict).toBe("proceed");
    // An email that only mentions a time, serving a request that schedules nothing, commits the user to nothing then.
    const v = user("u1", "s2");
    await p.observe(ev(v, { kind: "user_message", text: "Forward the notes from Thursday evening to Jamie Fox." }), {
      waitMs: 1_000,
    });
    const email = await p.checkAction(
      ev(v, {
        kind: "tool_call",
        tool: "send_email",
        input: { to: ["Jamie Fox"], body: "Notes from Thursday 19:00." },
      }),
    );
    expect(email.verdict).toBe("proceed");
  });

  test("paying an invoice already paid is a finding; one that names it as paid proceeds", async () => {
    const { p } = partner({ actionCheck: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Tyrell Bio says invoice INV-4821 is overdue. Please pay it." }),
      {
        waitMs: 1_000,
      },
    );
    const pay = await p.checkAction(
      ev(u, {
        kind: "tool_call",
        tool: "send_payment",
        input: { payee: "Tyrell Bio", amount: "4200", reference: "INV-4821" },
      }),
    );
    expect(pay.verdict).toBe("finding");
    expect(pay.finding?.citations.map((c) => c.itemId)).toContain("gmail:m-paid");
    const noted = await p.checkAction(
      ev(u, {
        kind: "tool_call",
        tool: "send_email",
        input: { to: ["Tyrell Bio"], subject: "INV-4821", body: "INV-4821 was already paid on 26 October." },
      }),
    );
    expect(noted.verdict).toBe("proceed");
  });

  test("isolation: one user's held items never hold another user's call; forget drops the session's state", async () => {
    const { p } = partner({ actionCheck: true });
    const a = user("alice");
    await p.observe(
      ev(a, { kind: "user_message", text: "Tyrell Bio says invoice INV-4821 is overdue. Please pay it." }),
      {
        waitMs: 1_000,
      },
    );
    // Bob's sources are empty: his call proceeds though Alice's cache holds the payment.
    const { p: q } = partner({ actionCheck: true }, []);
    const bob = await q.checkAction(
      ev(user("bob"), {
        kind: "tool_call",
        tool: "send_payment",
        input: { payee: "Tyrell Bio", reference: "INV-4821" },
      }),
    );
    expect(bob.verdict).toBe("proceed");
    // In one partner too: bob's session sees nothing of alice's.
    const b = user("bob");
    await p.observe(ev(b, { kind: "user_message", text: "Pay Tyrell Bio invoice INV-4821 please." }), {
      waitMs: 1_000,
    });
    const call = { kind: "tool_call", tool: "send_payment", input: { payee: "Tyrell Bio", reference: "INV-4821" } };
    const first = await p.checkAction(ev(a, call));
    expect(first.verdict).toBe("finding");
    expect((await p.checkAction(ev(a, call))).reason).toBe("repeat");
    p.forget({ tenantId: a.tenantId, userId: a.userId });
    // After forget, alice's remembered finding is gone with her session (and her cache): no "repeat".
    expect((await p.checkAction(ev(a, call))).reason).not.toBe("repeat");
  });

  test("a session remembers a bounded number of findings", async () => {
    const { p } = partner({ actionCheck: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Set up dinner with Jamie Fox on Thursday 29 October at 19:00." }),
      { waitMs: 1_000 },
    );
    for (let i = 0; i < 40; i++) {
      await p.checkAction(
        ev(u, {
          kind: "tool_call",
          tool: "schedule_event",
          input: { title: `Dinner ${i}`, start: "2026-10-29T19:00" },
        }),
      );
    }
    const sessions = (p as unknown as { sessions: Map<string, { checked?: Set<string> }> }).sessions;
    expect([...sessions.values()][0]!.checked!.size).toBeLessThanOrEqual(32);
  });
});

// ── econ integration (PR 6): privacy, the shared conflict test, session keying, failure ──

/** A GitHub token: the secret gate's rules redact it (`@eden/redact`). */
const TOKEN = "ghp_Zq9XvT2mLp8RkW4nJc6YbH1sDf3GtA5uE7iO";

describe("checkAction: integration", () => {
  test("tool arguments pass the secret gate before anything is kept, traced or returned", async () => {
    const { p, traces } = partner({ actionCheck: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Tyrell Bio says invoice INV-4821 is overdue. Please pay it." }),
      { waitMs: 1_000 },
    );
    const input = { payee: "Tyrell Bio", reference: "INV-4821", api_token: TOKEN, notes: `auth ${TOKEN}` };
    const r = await p.checkAction(ev(u, { kind: "tool_call", tool: "send_payment", input }));
    expect(r.verdict).toBe("finding");
    const sessions = (p as unknown as { sessions: Map<string, { window: string[]; vocab: Vocab }> }).sessions;
    const s = [...sessions.values()][0]!;
    const terms = Array.from({ length: s.vocab.size }, (_, i) => s.vocab.term(i));
    const kept = JSON.stringify({ window: s.window, terms, traces, r });
    expect(kept).not.toContain(TOKEN.slice(4));
    expect(kept).not.toContain("Zq9XvT2m");
  });

  test("a secret named only by its key (a password, an api_key) is gated before the call becomes words", async () => {
    // `actionText` turns {"password": "x"} into the line "password x", which the gate does not read as a secret; the
    // gate must see each argument as key and value first, as `observe` does with the JSON.
    const { p, traces } = partner({ actionCheck: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Tyrell Bio says invoice INV-4821 is overdue. Please pay it." }),
      { waitMs: 1_000 },
    );
    const input = {
      payee: "Tyrell Bio",
      reference: "INV-4821",
      password: "hunter2swordfish",
      api_key: "zzqqxxkey99887766",
    };
    const r = await p.checkAction(ev(u, { kind: "tool_call", tool: "send_payment", input }));
    expect([r.verdict, r.reason]).toEqual(["finding", "conflict"]);
    const sessions = (p as unknown as { sessions: Map<string, { window: string[]; vocab: Vocab }> }).sessions;
    const s = [...sessions.values()][0]!;
    const terms = Array.from({ length: s.vocab.size }, (_, i) => s.vocab.term(i));
    const kept = JSON.stringify({ window: s.window, terms, traces, r });
    expect(kept).not.toContain("hunter2swordfish");
    expect(kept).not.toContain("zzqqxxkey99887766");
  });

  test("a key-named secret is gated in the call's words, nested or listed; other arguments are kept", () => {
    const input = { payee: "Tyrell Bio", auth: { password: "hunter2swordfish" }, token: ["zzqqxxkey99887766"] };
    for (const prose of [true, false]) {
      const text = actionText("send_payment", input, { prose });
      expect(text).not.toContain("hunter2swordfish");
      expect(text).not.toContain("zzqqxxkey99887766");
      expect(text).toContain("payee Tyrell Bio");
    }
  });

  test("a call whose arguments JSON cannot hold (a BigInt, a cycle) still has a key that tells calls apart", () => {
    expect(actionKey("pay", { amount: 10n, to: "A" })).not.toBe(actionKey("pay", { amount: 99n, to: "B" }));
    expect(actionKey("pay", { amount: 10n, to: "A" })).toBe(actionKey("pay", { to: "A", amount: 10n }));
    const a: Record<string, unknown> = { to: "A" };
    a.self = a;
    const b: Record<string, unknown> = { to: "B" };
    b.self = b;
    expect(actionKey("pay", a)).not.toBe(actionKey("pay", b));
  });

  test("a call answered proceed still adds its redacted words to the session's vocabulary, as INTEGRATION says", async () => {
    // docs/INTEGRATION.md and PRIVACY.md tell tenants what a check keeps; this pins that statement to the code.
    const { p } = partner({ actionCheck: true });
    const u = user("u1");
    const r = await p.checkAction(ev(u, { kind: "tool_call", tool: "send_email", input: { to: "Dana" } }));
    expect(r.verdict).toBe("proceed");
    const sessions = (p as unknown as { sessions: Map<string, { vocab: Vocab; checked?: Set<string> }> }).sessions;
    const s = [...sessions.values()][0]!;
    const terms = Array.from({ length: s.vocab.size }, (_, i) => s.vocab.term(i));
    expect(terms).toContain("dana");
    // No digest for a call answered proceed: only a call with a finding is remembered.
    expect(s.checked?.size ?? 0).toBe(0);
  });

  test("a call's key is read through the secret gate: two calls differing only in a secret are one call", () => {
    const other = "ghp_" + "Ab3".repeat(12);
    expect(actionKey("deploy", { service: "api", token: TOKEN })).toBe(
      actionKey("deploy", { service: "api", token: other }),
    );
    expect(actionKey("deploy", { service: "api", token: TOKEN })).not.toBe(actionKey("deploy", { service: "web" }));
  });

  test("the firewall reads conflicts through the conflict test decideConflict shares (`conflicts`), one copy", async () => {
    for (const decideConflict of [false, true]) {
      const { p } = partner({ actionCheck: true, decideConflict });
      const spy = spyOn(p as unknown as { conflicts: (...a: unknown[]) => unknown }, "conflicts");
      const u = user("u1");
      await p.observe(
        ev(u, { kind: "user_message", text: "Tyrell Bio says invoice INV-4821 is overdue. Please pay it." }),
        { waitMs: 1_000 },
      );
      const before = spy.mock.calls.length;
      const r = await p.checkAction(
        ev(u, { kind: "tool_call", tool: "send_payment", input: { payee: "Tyrell Bio", reference: "INV-4821" } }),
      );
      expect(spy.mock.calls.length).toBeGreaterThan(before);
      expect([r.verdict, r.reason]).toEqual(["finding", "conflict"]);
      expect(r.finding?.citations.map((c) => c.itemId)).toContain("gmail:m-paid");
    }
  });

  test("a finding is remembered per session: another session or user making the same call is checked afresh", async () => {
    const { p } = partner({ actionCheck: true });
    const call = { kind: "tool_call", tool: "send_payment", input: { payee: "Tyrell Bio", reference: "INV-4821" } };
    const ask = { kind: "user_message", text: "Tyrell Bio says invoice INV-4821 is overdue. Please pay it." };
    for (const who of [user("alice", "s1"), user("alice", "s2"), user("bob", "s1")]) {
      await p.observe(ev(who, ask), { waitMs: 1_000 });
      const r = await p.checkAction(ev(who, call));
      expect([r.verdict, r.reason]).toEqual(["finding", "conflict"]);
    }
  });

  test("an internal failure proceeds (fails open) with its reason, and other events are not checked", async () => {
    const { p } = partner({ actionCheck: true });
    (p as unknown as { grounded: () => never }).grounded = () => {
      throw new Error("boom");
    };
    const u = user("u1");
    await p.observe(ev(u, { kind: "user_message", text: "Pay Tyrell Bio invoice INV-4821." }), { waitMs: 1_000 });
    const r = await p.checkAction(ev(u, { kind: "tool_call", tool: "send_payment", input: { reference: "INV-4821" } }));
    expect(r).toMatchObject({ verdict: "proceed", finding: null, reason: "error" });
    expect((await p.checkAction(ev(u, { kind: "user_message", text: "hi" }))).reason).toBe("off");
  });

  test("with the ALL packet flags on, a finding renders like any packet (dates whole with packetDates)", async () => {
    const { p } = partner({ actionCheck: true, compactInjection: true, densePacket: true, packetDates: true });
    const u = user("u1");
    await p.observe(
      ev(u, { kind: "user_message", text: "Set up dinner with Jamie Fox on Thursday 29 October at 19:00." }),
      { waitMs: 1_000 },
    );
    const r = await p.checkAction(
      ev(u, { kind: "tool_call", tool: "schedule_event", input: { title: "Dinner", start: "2026-10-29T19:00" } }),
    );
    expect(r.verdict).toBe("finding");
    expect(r.finding?.text.startsWith("<context")).toBe(true);
    expect(r.finding?.text).toContain("2026");
  });
});
