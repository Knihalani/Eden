import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { REALISTIC, simSources } from "../sources";
import { connectorHeader, connectorOptions, pushNotifier, sourceFields } from "./connector-options";

const opts = (given: Record<string, string>) => (name: string, fallback: string) => given[name] ?? fallback;

describe("connector options (--source-profile, --push)", () => {
  test("defaults: REALISTIC, no push, nothing in the header", () => {
    const o = connectorOptions(opts({}));
    expect(o.profiles).toBe(REALISTIC);
    expect(o.push).toBe("none");
    expect(connectorHeader(o)).toEqual({});
  });

  test("a profile override and a push mode are read and recorded; bad values are refused", () => {
    const o = connectorOptions(
      opts({ "source-profile": '{"gmail":{"latency":{"medianMs":600,"sigma":0.6}}}', push: "signals" }),
    );
    expect(o.profiles.gmail!.latency.medianMs).toBe(600);
    expect(o.profiles.drive).toEqual(REALISTIC.drive);
    expect(connectorHeader(o)).toMatchObject({ push: { mode: "signals" }, sourceProfile: { gmail: {} } });
    expect(() => connectorOptions(opts({ push: "sometimes" }))).toThrow(/--push/);
    expect(() => connectorOptions(opts({ "push-rates": "gmail=x" }))).toThrow(/push-rates/);
  });

  test("signals notify at the given rates, deterministically per seed; payload and none send none", () => {
    const world = buildWorld({ seed: 41_000 });
    const sent = (push: string, seed: number) => {
      const sources = simSources(world, REALISTIC, 0, seed);
      const notify = pushNotifier(sources, connectorOptions(opts({ push, "push-rates": "gmail=50,crm=0" })), seed);
      const got: string[] = [];
      for (let h = 0; h < 10; h++)
        notify({ sourceChanged: (_s, id) => (got.push(id), true) }, { tenantId: "t", userId: "u" });
      return { got, notifies: sources.every((s) => s.notifies) };
    };
    const a = sent("signals", 41);
    expect(a.notifies).toBe(true);
    expect(a.got.filter((id) => id === "gmail").length).toBe(10);
    expect(a.got.includes("crm")).toBe(false);
    expect(sent("signals", 41).got).toEqual(a.got);
    expect(sent("payload", 41)).toEqual({ got: [], notifies: true });
    expect(sent("none", 41)).toEqual({ got: [], notifies: false });
  });

  test("sourceFields keeps every field the engine reads off a source besides its calls", () => {
    const [s] = simSources(buildWorld({ seed: 41_000 }), REALISTIC, 0, 41);
    s!.notifies = true;
    const kept = sourceFields(s!);
    expect(kept).toEqual({
      id: s!.id,
      kind: "sim",
      description: s!.description,
      listsByTime: s!.listsByTime,
      notifies: true,
      fetchReportsGone: true,
    });
    // Every optional, non-call member of `Source` today: a new one must be added here and to `sourceFields`.
    const optional: (keyof typeof kept)[] = ["listsByTime", "notifies", "fetchReportsGone"];
    for (const k of optional) expect(k in kept).toBe(true);
  });
});
