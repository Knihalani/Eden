import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { REALISTIC, simSources } from "../sources";
import type { ContextItem } from "@eden/protocol";
import { connectorHeader, connectorOptions, pushNotifier, recapNotice, sourceFields } from "./connector-options";

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

describe("recapNotice (D272): the notice for a recap's moved items", () => {
  const item = (id: string) =>
    ({ id, sourceId: id.split(":")[0]!, ref: id.split(":")[1]!, title: id, text: id }) as ContextItem;
  const sources = [
    { id: "gmail", listAll: () => [item("gmail:a"), item("gmail:b")] },
    { id: "slack", listAll: () => [item("slack:c")] },
  ];
  const fake = () => {
    const calls: string[] = [];
    return {
      calls,
      sourceChanged: (_s: unknown, id: string) => (calls.push(`signal ${id}`), true),
      sourceItems: async (_s: unknown, id: string, items: ContextItem[]) => (
        calls.push(`items ${id} ${items.map((x) => x.id).join(",")}`),
        items.length
      ),
      sourceRefs: (_s: unknown, id: string, refs: string[]) => (
        calls.push(`refs ${id} ${refs.join(",")}`),
        { settled: Promise.resolve(refs.length) }
      ),
    };
  };
  const scope = { tenantId: "t", userId: "u" };

  test("payload: the moved items themselves, no signal", async () => {
    const p = fake();
    expect(await recapNotice(p, scope, sources, new Set(["gmail:b"]), "payload")).toBe(1);
    expect(p.calls).toEqual(["items gmail gmail:b"]);
  });

  test("refs (D347): the moved items named by ref, no signal", async () => {
    const p = fake();
    expect(await recapNotice(p, scope, sources, new Set(["gmail:b"]), "refs")).toBe(1);
    expect(p.calls).toEqual(["refs gmail b"]);
  });

  test("signals: a bare signal per source with a moved item; none: nothing", async () => {
    const p = fake();
    await recapNotice(p, scope, sources, new Set(["gmail:a", "slack:c"]), "signals");
    expect(p.calls).toEqual(["signal gmail", "signal slack"]);
    const q = fake();
    await recapNotice(q, scope, sources, new Set(["gmail:a"]), "none");
    expect(q.calls).toEqual([]);
  });
});
