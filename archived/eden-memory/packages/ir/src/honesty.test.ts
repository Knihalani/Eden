import { describe, expect, test } from "bun:test";
import {
  diagnoseHonesty,
  renderHonestyLetter,
  honestyShape,
  honestyWidth,
  HONESTY_MIN_STEPS,
  HONESTY_MIN_SUPPORT,
} from "./honesty";
import type { StretchTrace } from "./types";

function trace(id: string, names: string[], input: Record<string, unknown> = {}): StretchTrace {
  return {
    id,
    llmCalls: names.length,
    duration_ms: 10,
    cost_cents: 1,
    input,
    complete: true,
    events: names.map((name) => ({ name, args: input, result: { ok: true }, ok: true })),
  } as StretchTrace;
}

describe("honesty diagnosis", () => {
  test("empty set is nothing recorded with have 0", () => {
    const f = diagnoseHonesty([]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ code: "nothing_recorded", have: 0, need: 1 });
    expect(f[0]!.detail).toBe("0 stretches");
    expect(renderHonestyLetter({ findings: f })).toMatch(/Nothing recorded/);
    expect(renderHonestyLetter({ findings: f })).toMatch(/0 stretches/);
  });

  test("micro: 16 stretches of 2 calls names Too short · 16 … (need 3)", () => {
    const traces = Array.from({ length: 16 }, (_, i) => trace(`m${i}`, ["lookup", "reply"], { id: "T1" }));
    const f = diagnoseHonesty(traces);
    const short = f.find((x) => x.code === "under_support");
    expect(short).toBeDefined();
    expect(short!.have).toBe(2);
    expect(short!.need).toBe(HONESTY_MIN_STEPS);
    expect(short!.count).toBe(16);
    expect(short!.detail).toBe("16 stretches of 2 calls (need 3)");
    expect(short!.label).toBe("Too short");
    expect(f.some((x) => x.code === "high_entropy")).toBe(false);
    const letter = renderHonestyLetter({ findings: f });
    expect(letter).toMatch(/Too short · 16 stretches of 2 calls \(need 3\)/);
    expect(letter).toMatch(/Wrap a stretch of at least three steps/);
  });

  test("unique-work: 12 distinct sequences names Unique work with the count", () => {
    const traces = Array.from({ length: 12 }, (_, i) =>
      trace(`u${i}`, ["alpha", "beta", `uniq${i}`], { id: `id${i}` }),
    );
    const f = diagnoseHonesty(traces);
    const ent = f.find((x) => x.code === "high_entropy");
    expect(ent).toBeDefined();
    expect(ent!.have).toBe(12);
    expect(ent!.need).toBe(HONESTY_MIN_SUPPORT);
    expect(ent!.detail).toBe("12 distinct sequences in 12 stretches");
    const letter = renderHonestyLetter({ findings: f });
    expect(letter).toMatch(/Unique work · 12 distinct sequences in 12 stretches/);
    expect(letter).toMatch(/Nothing was lost\. Unique work stays raw\./);
  });

  test("width split: same shape, width 10 has 2 of 3", () => {
    const wide = (id: string, n: number) =>
      trace(id, ["findOrder", ...Array.from({ length: n }, () => "lineItem"), "refund"], { order: id });
    const traces = [wide("a", 7), wide("b", 7), wide("c", 7), wide("d", 10), wide("e", 10)];
    expect(honestyShape(traces[0]!.events.map((e) => e.name))).toBe(honestyShape(traces[3]!.events.map((e) => e.name)));
    expect(honestyWidth(traces[3]!.events.map((e) => e.name))).toBe(10);
    const f = diagnoseHonesty(traces);
    const split = f.find((x) => x.code === "width_split");
    expect(split).toBeDefined();
    expect(split!.have).toBe(2);
    expect(split!.need).toBe(3);
    expect(split!.detail).toMatch(/2 of 3 same-shape at width 10/);
    expect(renderHonestyLetter({ findings: f })).toMatch(/Width split · 2 of 3 same-shape at width 10/);
    expect(renderHonestyLetter({ findings: f })).toMatch(/Need three of the same fan-out width/);
  });

  test("envelope gap: same shape, every id novel", () => {
    const traces = Array.from({ length: 4 }, (_, i) =>
      trace(`h${i}`, ["lookup", "fetch", "reply"], { id: `novel-${i}` }),
    );
    const f = diagnoseHonesty(traces);
    const gap = f.find((x) => x.code === "envelope_gap");
    expect(gap).toBeDefined();
    expect(gap!.have).toBe(1);
    expect(gap!.need).toBe(3);
    expect(gap!.detail).toMatch(/4 novel ids, 0 repeats \(need 3 of the same id\)/);
    expect(renderHonestyLetter({ findings: f })).toMatch(/Envelope gap/);
    expect(renderHonestyLetter({ findings: f })).toMatch(/The same id must repeat inside the envelope/);
  });

  test("repeated same-shape same-id long enough is silent", () => {
    const traces = Array.from({ length: 4 }, (_, i) => trace(`ok${i}`, ["lookup", "fetch", "reply"], { id: "T-1" }));
    expect(diagnoseHonesty(traces)).toEqual([]);
    expect(renderHonestyLetter({ findings: [], live: 2 })).toMatch(/0 refusals · 2 programs/);
    expect(renderHonestyLetter({ findings: [], live: 2, serving: "1 Canary · 1 Live" })).toMatch(
      /0 refusals · 1 Canary · 1 Live/,
    );
    expect(renderHonestyLetter({ findings: [], live: 2, serving: "1 Canary · 1 Live" })).not.toMatch(/2 live/);
  });

  test("per-candidate refusal uses the same Home words", () => {
    const letter = renderHonestyLetter({
      findings: [],
      refusals: [{ reason: "fewer than 3 steps" }, { reason: "read set", readSet: 6, repeats: 2 }],
      live: 0,
    });
    expect(letter).toMatch(/Too short/);
    expect(letter).toMatch(/Read-set · 2 of 6/);
  });

  test("corrupt-ish traces (missing events) do not throw", () => {
    expect(() => diagnoseHonesty([{ id: "x" } as StretchTrace])).not.toThrow();
    expect(diagnoseHonesty([null as unknown as StretchTrace])[0]!.code).toBe("nothing_recorded");
  });
});
