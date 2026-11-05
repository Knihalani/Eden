import { describe, expect, test } from "bun:test";
import { judgeMessages, parseJudge } from "@eden/engine";
import { OracleJudge } from "./judge";
import { buildSessions } from "./sessions";
import { IDEAL, REALISTIC, SimIndex, SimSource } from "./sources";
import {
  mergeTallies,
  qualityReport,
  runQuality,
  tallyQuality,
  type QualityReport,
  type QualityTally,
} from "./quality";
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

  test("user-range tallies merge into the whole run's report (quality-cli --jobs), timing aside", async () => {
    const o = {
      // Two users of two sessions: the smallest run with a shard boundary and more than one session per shard.
      users: 2,
      sessionsPerUser: 2,
      seed: 3,
      profiles: REALISTIC,
      timeScale: 0,
      waitMs: 0,
      model: null,
      updates: 0.5,
      deletes: 0.1,
      push: "signals" as const,
    };
    const untimed = (r: QualityReport) => JSON.stringify({ ...r, latency: null, cpu: null });
    const whole = await runQuality(o);
    // Shards print their tallies as JSON, so the merge reads them as parsed JSON.
    const shards = await Promise.all(
      [
        [0, 1],
        [1, 2],
      ].map(
        async ([a, b]) => JSON.parse(JSON.stringify(await tallyQuality({ ...o, userRange: [a!, b!] }))) as QualityTally,
      ),
    );
    const merged = mergeTallies(shards);
    expect(merged.users).toBe(2);
    expect(untimed(qualityReport(merged, o))).toBe(untimed(whole));
    // Latency percentiles come from the concatenated samples, not from shard percentiles.
    expect(merged.samples.observeMs.length).toBe(
      shards[0]!.samples.observeMs.length + shards[1]!.samples.observeMs.length,
    );
    // Merging adds; the inputs are left as they were.
    expect(shards[0]!.users).toBe(1);
    await expect(tallyQuality({ ...o, userRange: [1, 3] })).rejects.toThrow(/userRange/);
    await expect(tallyQuality({ ...o, userRange: [1, 1] })).rejects.toThrow(/no user/);
  }, 20_000);

  test("mergeTallies sums key by key, keeps first-seen key order, and treats any key as plain data", () => {
    const t = (needDecisions: Record<string, number>): QualityTally =>
      ({ users: 1, counts: { needDecisions }, samples: { observeMs: [1], deliveryMs: [], injBytes: [2] } }) as never;
    const m = mergeTallies([t({ b: 1 }), t(JSON.parse('{"a": 2, "b": 3, "__proto__": 4}'))]);
    expect(Object.keys(m.counts.needDecisions)).toEqual(["b", "a", "__proto__"]);
    expect(m.counts.needDecisions.b).toBe(4);
    expect(Object.hasOwn(m.counts.needDecisions, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(m.counts.needDecisions)).toBe(Object.prototype);
    expect(m.samples.observeMs).toEqual([1, 1]);
    expect(() => mergeTallies([])).toThrow();
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

  test("an in-place edit reaches search after reindex: the per-item memo never serves the old words", async () => {
    const w = buildWorld({ seed: 4 });
    const item = w.items.find((i) => i.sourceId === "drive")!;
    const other = w.items.find((i) => i.sourceId === "drive" && i !== item)!;
    const ranked = new SimSource(new SimIndex("drive", w), IDEAL.drive!, 0, 1);
    const substring = new SimSource(new SimIndex("drive", w), { ...IDEAL.drive!, semantics: "substring" }, 0, 1);
    const ids = async (s: SimSource, text: string) =>
      (await s.search({ scope, text, entities: [], limit: 50 }, signal)).map((h) => h.id);
    const oldWord = "Zebrafinch";
    const newWord = "Quokkaville";
    // The item first states the old word (indexed, so memoised), then is edited in place, as applyUpdate does.
    item.text = `${item.text} Venue: ${oldWord}.`;
    ranked.reindex();
    substring.reindex();
    expect(await ids(ranked, oldWord)).toEqual([item.id]);
    expect(await ids(substring, oldWord)).toEqual([item.id]);
    item.text = item.text.replaceAll(oldWord, newWord);
    item.title = `${item.title} Ünïcode`;
    // Before the reindex the old index still answers; after it the new words are found and the old ones are gone.
    expect(await ids(ranked, newWord)).toEqual([]);
    ranked.reindex();
    substring.reindex();
    expect(await ids(ranked, newWord)).toEqual([item.id]);
    expect(await ids(ranked, oldWord)).toEqual([]);
    expect(await ids(substring, newWord.toLowerCase())).toEqual([item.id]);
    expect(await ids(substring, oldWord)).toEqual([]);
    expect(await ids(ranked, "unicode")).toContain(item.id); // The title's new word, accents folded.
    // An unchanged item reads the same through a fresh index (served from the memo).
    expect(await ids(ranked, other.title)).toEqual(
      await ids(new SimSource(new SimIndex("drive", w), IDEAL.drive!, 0, 1), other.title),
    );
  });

  test("relabel moves later sessions' tool output, uses and asks to the new version; old and new text read apart", () => {
    const w = buildWorld({ seed: 4 });
    const fact = [...w.facts.values()].find((f) => /\d\d:\d\d/.test(f.detail))!;
    const from = /\d\d:\d\d/.exec(fact.detail)![0];
    const u = { session: 1, fact: fact.id, next: `${fact.id}@v2`, from, to: "23:59", items: fact.items };
    const turn = (fetched: string[]) => ({
      event: { kind: "tool_result" as const, tool: "t", output: `at ${from}` },
      label: { kind: "context" as const, ok: [fact.id] },
      uses: [fact.id],
      fetched,
    });
    const sessions = [0, 1].map((i) => ({
      id: `s${i}`,
      tasks: [{ type: "x", style: "none" as const, turns: [turn([fact.id])] }],
    }));
    const asks = [{ question: "q", must: [fact.id], ok: [], style: "none" as const, arc: "a" }];
    relabel(sessions, asks, [u]);
    const [before, after] = sessions.map((x) => x.tasks[0]!.turns[0]!);
    expect(before!.uses).toEqual([fact.id]);
    expect(after!.uses).toEqual([u.next]);
    expect((after!.event as { output: string }).output).toBe("at 23:59");
    expect((before!.event as { output: string }).output).toBe(`at ${from}`);
    expect(asks[0]!.must).toEqual([u.next]);
    const item = { ...w.items.find((i) => i.id === fact.items[0])!, facts: [u.next] };
    // A text holding both times is the new version (a note quoting the change), not a stale copy.
    expect(factsShown(item, `was ${from}, now 23:59`, [u])).toEqual([u.next]);
    expect(factsShown(item, `at ${from}`, [u])).toEqual([fact.id]);
  });

  test("a fact sharing its time with another fact on the same item is not updated", () => {
    const w = buildWorld({ seed: 4 });
    const item = w.items.find((i) => i.facts.length > 0)!;
    item.text = "Lunch at 12:30, call at 12:30";
    const [a, b] = ["t:one", "t:two"];
    w.facts.set(a, { id: a, detail: "lunch 12:30", items: [item.id] });
    w.facts.set(b, { id: b, detail: "call 12:30", items: [item.id] });
    item.facts = [a, b];
    const updates = planUpdates(w, 4, 1, 1);
    expect(updates.map((u) => u.fact)).not.toContain(a);
    expect(updates.map((u) => u.fact)).not.toContain(b);
  });

  test("a run without updates scores exactly as before; with them, stale deliveries are counted", async () => {
    const base = { users: 1, sessionsPerUser: 6, seed: 2, profiles: REALISTIC, timeScale: 0, waitMs: 0, model: null };
    const off = await runQuality(base);
    expect(off.updates).toEqual({ planned: 0, applied: 0, updatedDelivered: 0, staleDelivered: 0 });
    const on = await runQuality({ ...base, updates: 0.5 });
    expect(on.updates.applied).toBe(on.updates.planned);
    expect(on.updates.planned).toBeGreaterThan(0);
    // Two full quality runs: 2.1-2.5 s alone, but over bun's 5 s default under the parallel gate's load (5.1-6.0 s
    // seen in the 2026-11-03b audit). 20 s still catches a hang.
  }, 20_000);
});
