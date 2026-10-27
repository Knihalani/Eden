import { describe, expect, test } from "bun:test";
import { buildSessions } from "./sessions";
import { IDEAL, REALISTIC, SimSource } from "./sources";
import { runQuality } from "./quality";
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
    const gmail = new SimSource("gmail", w, REALISTIC.gmail!, 0, 1);
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
    const cal = new SimSource("calendar", w, IDEAL.calendar!, 0, 1);
    const hits = await cal.search(
      { scope, text: `${arc.slots.activity} ${arc.person!.full}`, entities: [], limit: 5 },
      signal,
    );
    expect(hits.some((h) => w.items.find((i) => i.id === h.id)!.facts.includes(arc.facts.event!))).toBe(true);
  });

  test("an outage fails every call; errors are counted", async () => {
    const s = new SimSource("drive", w, IDEAL.drive!, 0, 1);
    s.fault = { outage: [0, 60_000] };
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
