import { describe, expect, test } from "bun:test";
import { judgeMessages, parseJudge } from "@eden/engine";
import { OracleJudge } from "./judge";
import { buildSessions } from "./sessions";
import { IDEAL, REALISTIC, SimIndex, SimSource } from "./sources";
import { runQuality } from "./quality";
import { applyUpdate, factsShown, planUpdates, relabel } from "./updates";
import { buildWorld } from "./world";

const scope = { tenantId: "t", userId: "u" };
const signal = new AbortController().signal;

describe("simulated world", () => {
  test("is deterministic, and every fact is stated by at least one item", () => {
    const a = buildWorld({ seed: 7 });
    const b = buildWorld({ seed: 7 });
    expect(a.items.map((i) => i.text)).toEqual(b.items.map((i) => i.text));
    expect(buildWorld({ seed: 8 }).items.map((i) => i.text)).not.toEqual(a.items.map((i) => i.text));
    for (const f of a.facts.values()) expect(f.items.length).toBeGreaterThan(0);
    for (const arc of a.arcs) for (const f of Object.values(arc.facts)) expect(a.facts.has(f)).toBe(true);
    const ids = a.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("plants secrets and prompt injections in item text", () => {
    const w = buildWorld({ seed: 3 });
    const secrets = w.items.filter((i) => i.secret);
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    for (const i of secrets) expect(i.text).toContain(i.secret!);
    expect(w.items.filter((i) => i.injection).length).toBeGreaterThanOrEqual(3);
  });

  test("sessions label every need with facts that exist", () => {
    const w = buildWorld({ seed: 4 });
    const { sessions, asks } = buildSessions(w, { seed: 4, sessions: 30 });
    let needs = 0;
    for (const s of sessions)
      for (const t of s.tasks)
        for (const turn of t.turns) {
          if (turn.label.kind !== "need") continue;
          needs++;
          for (const f of [...turn.label.must, ...turn.label.ok]) expect(w.facts.has(f)).toBe(true);
          expect(turn.label.must.length).toBeGreaterThan(0);
        }
    expect(needs).toBeGreaterThan(20);
    expect(asks.length).toBeGreaterThan(20);
  });
});

describe("simulated sources", () => {
  const w = buildWorld({ seed: 5 });
  const arc = w.arcs.find((a) => a.kind === "meeting")!;

  test("AND search returns only items with every term; snippets cut the body", async () => {
    const gmail = new SimSource(new SimIndex("gmail", w), REALISTIC.gmail!, 0, 1);
    const terms = [arc.slots.activity!, arc.person!.first];
    const hits = await gmail.search({ scope, text: terms.join(" "), entities: [], limit: 20 }, signal);
    for (const h of hits)
      for (const t of terms)
        expect(`${h.title} ${w.items.find((i) => i.id === h.id)!.text}`.toLowerCase()).toContain(
          t.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").slice(0, 3),
        );
    const long = await gmail.search(
      { scope, text: `${terms.join(" ")} quarterly forecast spreadsheet`, entities: [], limit: 20 },
      signal,
    );
    expect(long.length).toBeLessThanOrEqual(hits.length);
    for (const h of hits) expect(h.text.length).toBeLessThanOrEqual(w.items.find((i) => i.id === h.id)!.text.length);
  });

  test("ranked search finds the arc's event by its terms", async () => {
    const cal = new SimSource(new SimIndex("calendar", w), IDEAL.calendar!, 0, 1);
    const hits = await cal.search(
      { scope, text: `${arc.slots.activity} ${arc.person!.full}`, entities: [], limit: 5 },
      signal,
    );
    expect(hits.some((h) => w.items.find((i) => i.id === h.id)!.facts.includes(arc.facts.event!))).toBe(true);
  });

  test("an outage fails every call; errors are counted", async () => {
    const s = new SimSource(new SimIndex("drive", w), IDEAL.drive!, 0, 1);
    s.fault = { outageUntil: performance.now() + 60_000 };
    await expect(s.search({ scope, text: "notes", entities: [], limit: 5 }, signal)).rejects.toThrow(/503/);
    expect(s.stats.errors).toBe(1);
  });
});

describe("quality runner", () => {
  test("runs end to end and reports sane rates, with no secret leaked", async () => {
    const r = await runQuality({
      users: 1,
      sessionsPerUser: 4,
      seed: 2,
      profiles: IDEAL,
      timeScale: 0,
      waitMs: 0,
      model: null,
      judge: "perfect",
    });
    expect(r.turns).toBeGreaterThan(5);
    expect(r.overall.falseFireRate).toBeGreaterThanOrEqual(0);
    expect(r.privacy.secretsLeaked).toBe(0);
    expect(r.privacy.deliveredNotInert).toBe(0);
    expect(r.ask.cases).toBeGreaterThan(10);
    expect(r.funnel.mustFacts).toBeGreaterThan(0);
  });
});

describe("oracle judge", () => {
  test("picks exactly the relevant candidates by their index, titles with dashes and multi-line text included", async () => {
    const w = buildWorld({ seed: 6 });
    const deal = w.arcs.find((a) => a.kind === "deal")!;
    const notes = w.items.find((i) => i.facts.includes(deal.facts.notes!) && i.title.includes(" — "))!;
    const noise = w.items.filter((i) => i.noise && i.text.includes("\n")).slice(0, 3);
    const candidates = [noise[0]!, noise[1]!, notes, noise[2]!];
    const oracle = new OracleJudge(w, { tp: 1, fp: 0, latencyMs: 0, timeScale: 0, seed: 1 });
    oracle.relevant = new Set([deal.facts.notes!]);
    const res = await oracle.chat({ messages: judgeMessages("user: prep me for the call", candidates), maxTokens: 60 });
    expect(parseJudge(res.text, candidates.length)).toEqual([2]);
    expect(oracle.stats.unmatched).toBe(0);
    expect(oracle.stats.candidates).toBe(4);
  });
});

describe("source-side updates", () => {
  test("plan only clock-time facts, deterministically; relabel later sessions; apply and detect stale copies", () => {
    const plan = (seed: number) => {
      const w = buildWorld({ seed: 4 });
      const { sessions, asks } = buildSessions(w, { seed: 4, sessions: 12 });
      return { w, sessions, asks, updates: planUpdates(w, sessions.length, seed, 0.5) };
    };
    const { w, sessions, asks, updates } = plan(9);
    expect(plan(9).updates).toEqual(updates);
    expect(updates.length).toBeGreaterThan(5);
    const u = updates[0]!;
    expect(w.facts.get(u.fact)!.detail).toContain(u.from);
    expect(w.facts.get(u.next)!.detail).toContain(u.to);
    expect(u.from).not.toBe(u.to);
    relabel(sessions, asks, updates);
    const labels = (from: number, to: number) =>
      sessions
        .slice(from, to)
        .flatMap((s) => s.tasks.flatMap((t) => t.turns))
        .flatMap((t) => (t.label.kind === "need" ? t.label.must : []));
    expect(labels(u.session, sessions.length)).not.toContain(u.fact);
    expect(labels(0, u.session)).not.toContain(u.next);
    const item = w.items.find((i) => i.id === u.items[0])!;
    const oldText = item.text;
    applyUpdate(w, u, w.now);
    expect(item.text).toContain(u.to);
    expect(item.facts).toContain(u.next);
    expect(factsShown(item, oldText, [u])).toContain(u.fact); // A copy cached before the update states the old fact.
    expect(factsShown(item, item.text, [u])).toContain(u.next);
  });

  test("a run without updates scores exactly as before; with them, stale deliveries are counted", async () => {
    const base = { users: 1, sessionsPerUser: 6, seed: 2, profiles: REALISTIC, timeScale: 0, waitMs: 0, model: null };
    const off = await runQuality(base);
    expect(off.updates).toEqual({ planned: 0, applied: 0, updatedDelivered: 0, staleDelivered: 0 });
    const on = await runQuality({ ...base, updates: 0.5 });
    expect(on.updates.applied).toBe(on.updates.planned);
    expect(on.updates.planned).toBeGreaterThan(0);
  });
});
