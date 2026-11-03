import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@eden/engine";
import { edenHome } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { buildPartner, openSourceMap } from "./build";
import { stdioSourceMapPath } from "./config";
import { ANTICIPATE_PARTS, engineConfig, parseEngineConfig } from "./engine-config";

const dir = mkdtempSync(join(edenHome(), "engine-config-"));
const file = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

describe("EDEN_ENGINE_CONFIG (D103)", () => {
  test("unset: the partner runs on the production defaults exactly", () => {
    expect(engineConfig({})).toEqual({});
    expect(engineConfig({ EDEN_ENGINE_CONFIG: "" })).toEqual({});
    const partner = buildPartner({ sources: async () => [], model: null, engine: engineConfig({}) });
    expect(partner.config).toEqual(DEFAULT_CONFIG);
  });

  test("a valid file is applied over the defaults", () => {
    const path = file(
      "ok.json",
      JSON.stringify({
        probes: true,
        compactAsk: true,
        askItemBytes: 240,
        probeWhen: "actions",
        probeOff: ["calendar"],
      }),
    );
    const engine = engineConfig({ EDEN_ENGINE_CONFIG: path });
    expect(engine).toEqual({
      probes: true,
      compactAsk: true,
      askItemBytes: 240,
      probeWhen: "actions",
      probeOff: ["calendar"],
    });
    const partner = buildPartner({ sources: async () => [], model: null, engine });
    expect(partner.config).toEqual({ ...DEFAULT_CONFIG, ...engine });
  });

  test("askWithModel: the file's value holds when the option is unset; an explicit option wins, as before D103", () => {
    const build = (askWithModel: boolean | undefined, engine: { askWithModel?: boolean }) =>
      buildPartner({ sources: async () => [], model: null, askWithModel, engine }).config.askWithModel;
    expect(build(undefined, { askWithModel: true })).toBe(true);
    expect(build(false, { askWithModel: true })).toBe(false);
    expect(build(true, {})).toBe(true);
    expect(build(undefined, {})).toBe(false);
  });

  test("a flag whose partner dependency the servers do not wire is refused, naming it and the dependency", () => {
    // buildPartner wires no cards, bridge or reader: turned on, these would be accepted by the engine and do nothing.
    const needs = {
      cards: "cards",
      cardsEconomy: "cards",
      intent: "cards",
      bridgeQuery: "bridge",
      bridgeQuestions: "bridge",
      askReader: "reader",
      askReaderQuestions: "reader",
      askReaderClear: "reader",
      askReaderDrop: "reader",
      readerPush: "reader",
      readerPushNotes: "reader",
      readerGate: "reader",
    };
    for (const [key, dep] of Object.entries(needs)) {
      expect(() => parseEngineConfig({ probes: true, [key]: true })).toThrow(
        new RegExp(`"${key}" needs the partner's ${dep} dependency`),
      );
      // Off is the default and harmless.
      expect(parseEngineConfig({ [key]: false })).toEqual({ [key]: false });
    }
    const path = file("all3.json", JSON.stringify({ probes: true, graph: true, cards: true }));
    expect(() => engineConfig({ EDEN_ENGINE_CONFIG: path })).toThrow(/EDEN_ENGINE_CONFIG .*"cards" needs/);
    // Each one is a dependency buildPartner does not wire.
    const partner = buildPartner({ sources: async () => [], model: null }) as unknown as {
      deps: Record<string, unknown>;
    };
    for (const dep of new Set(Object.values(needs))) expect(partner.deps[dep]).toBeUndefined();
  });

  test("readerPushBehind, syncPush* and sync are refused, naming what the servers lack (audit 2026-11-03b r3)", () => {
    // readerPushBehind acts only on the reader's push (partner.ts ask with internal.push), so it needs the reader.
    expect(() => parseEngineConfig({ readerPushBehind: true })).toThrow(
      /"readerPushBehind" needs the partner's reader dependency/,
    );
    // Push sync acts only once a route relays source watches and change notices (sourcePushes, sourceChanged).
    for (const [key, value] of [
      ["syncPush", true],
      ["syncPushMaxStaleMs", 1000],
      ["syncPushSweepMs", 1000],
      ["syncPushGapMs", 1000],
    ] as const) {
      expect(() => parseEngineConfig({ [key]: value })).toThrow(
        new RegExp(`"${key}" needs a server route that relays source watches and change notices`),
      );
    }
    // The servers build only StaticSources (connectors.ts), which have no list tool: sync would list nothing.
    expect(() => parseEngineConfig({ sync: true })).toThrow(/"sync" needs sources with a list tool/);
    const path = file("sync.json", JSON.stringify({ probes: true, sync: true }));
    expect(() => engineConfig({ EDEN_ENGINE_CONFIG: path })).toThrow(/EDEN_ENGINE_CONFIG .*"sync" needs sources/);
    // With sync refused, its sub-settings would start cleanly and do nothing (partner.ts gates them on this.sync).
    for (const [key, value] of [
      ["syncPollBehind", true],
      ["syncOnDemand", false],
      ["syncWide", true],
      ["syncPollPageSize", 5],
      ["syncEveryMs", 60_000],
      ["syncStaleChance", 1],
    ] as const) {
      expect(() => parseEngineConfig({ [key]: value })).toThrow(new RegExp(`"${key}" needs sources with a list tool`));
    }
    // Their defaults stay accepted.
    const defaults = {
      readerPushBehind: false,
      sync: false,
      syncPush: false,
      syncPushMaxStaleMs: DEFAULT_CONFIG.syncPushMaxStaleMs,
      syncPushSweepMs: DEFAULT_CONFIG.syncPushSweepMs,
      syncPushGapMs: DEFAULT_CONFIG.syncPushGapMs,
    };
    expect(parseEngineConfig(defaults)).toEqual(defaults);
  });

  test("every reader, card, bridge, intent, digest, push and sync key is refused off its default or allow-listed", () => {
    // A new key of these families acts only through something the servers do not wire (a paid model dependency, a
    // push route) unless shown otherwise. Each must be refused at a non-default value, or listed here with the reason
    // it does something from the shipped servers.
    const allowed: Record<string, string> = {};
    const other = (value: unknown): unknown => {
      if (typeof value === "boolean") return !value;
      // A legal non-default (`RANGES` is checked first): 0 is illegal for sizes, and a share must stay at most 1.
      if (typeof value === "number") return value === 0 ? 1 : Number.isInteger(value) ? value + 1 : value / 2;
      if (Array.isArray(value)) return value.length ? [] : ["x"];
      throw new Error(`no non-default value for ${JSON.stringify(value)}`);
    };
    // Sync is refused while the servers build no listable sources, so every sync sub-setting would be inert too.
    const keys = Object.keys(DEFAULT_CONFIG).filter((key) => /reader|card|bridge|intent|digest|push|^sync/i.test(key));
    expect(keys.length).toBeGreaterThanOrEqual(36 + 18);
    const unguarded: string[] = [];
    for (const key of keys) {
      if (allowed[key] !== undefined) continue;
      const value = other(DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG]);
      try {
        parseEngineConfig({ [key]: value });
        unguarded.push(key);
      } catch (error) {
        expect((error as Error).message).toContain(`"${key}" needs `);
      }
    }
    expect(unguarded).toEqual([]);
  });

  test("an unknown key stops startup with an error naming it", () => {
    const path = file("typo.json", JSON.stringify({ probes: true, askReder: true }));
    expect(() => engineConfig({ EDEN_ENGINE_CONFIG: path })).toThrow(/unknown key "askReder"/);
    // Inherited object keys are not settings.
    expect(() => parseEngineConfig(JSON.parse('{"__proto__": {"probes": true}}'))).toThrow(/unknown key "__proto__"/);
    expect(() => parseEngineConfig({ toString: "x" })).toThrow(/unknown key "toString"/);
  });

  test("a wrong type stops startup with an error naming the key", () => {
    expect(() => parseEngineConfig({ probes: "true" })).toThrow(/"probes" must be a boolean/);
    expect(() => parseEngineConfig({ askItemBytes: "240" })).toThrow(/"askItemBytes" must be a number/);
    expect(() => parseEngineConfig({ askItemBytes: -1 })).toThrow(/"askItemBytes" must be a number/);
    expect(() => parseEngineConfig({ probeOff: "calendar" })).toThrow(/"probeOff" must be an array of strings/);
    expect(() => parseEngineConfig({ probeOff: [1] })).toThrow(/"probeOff" must be an array of strings/);
    expect(() => parseEngineConfig({ probeWhen: "sometimes" })).toThrow(/"probeWhen" must be one of always, actions/);
    expect(() => parseEngineConfig([])).toThrow(/must be a JSON object/);
  });

  test("settings that would do nothing or break a feature are refused, naming the key (audit 2026-11-03b)", () => {
    const refused: [Record<string, unknown>, string][] = [
      // Acts only with cards (digestFor), which the servers do not wire.
      [{ constraintDigest: true }, "constraintDigest"],
      [{ digestLines: 3 }, "digestLines"],
      [{ digestBytes: 10 }, "digestBytes"],
      // Dependency-only numbers: refused unless at their default.
      [{ askReaderStanding: 20 }, "askReaderStanding"],
      [{ readerPushWaitMs: 5 }, "readerPushWaitMs"],
      [{ bridgeAskSeats: 2 }, "bridgeAskSeats"],
      [{ readerPushKinds: ["blocks"] }, "readerPushKinds"],
      // A typo switches nothing off.
      [{ anticipateOff: ["srve"] }, "anticipateOff"],
      // 0-item pages: nothing syncs.
      [{ syncPageSize: 0, sync: true }, "syncPageSize"],
      // A 0 cap stops backfill at once and trims every synced item: sync silently off.
      [{ syncMaxItems: 0, sync: true }, "syncMaxItems"],
      [{ syncStaleChance: 7 }, "syncStaleChance"],
      [{ askReaderPool: 2.5 }, "askReaderPool"],
      [{ maxItemsPerInjection: 1.5 }, "maxItemsPerInjection"],
      [{ maxSessionsPerTenant: 0 }, "maxSessionsPerTenant"],
    ];
    for (const [config, key] of refused) {
      expect(() => parseEngineConfig(config)).toThrow(new RegExp(`"${key}"`));
    }
    expect(() => parseEngineConfig({ syncStaleChance: 7 })).toThrow(/"syncStaleChance" must be at most 1/);
    expect(() => parseEngineConfig({ askReaderPool: 2.5 })).toThrow(/"askReaderPool" must be a whole number/);
    expect(() => parseEngineConfig({ syncPageSize: 0 })).toThrow(/"syncPageSize" must be at least 1/);
    expect(() => parseEngineConfig({ anticipateOff: ["serve", "srve"] })).toThrow(/"anticipateOff" has "srve"/);
    // Legal: nothing, 0 where 0 means off, defaults of dependency-only keys, chances at the bounds, real parts.
    const accepted: Record<string, unknown>[] = [
      {},
      { syncPollPageSize: 0, syncPageSize: DEFAULT_CONFIG.syncPageSize },
      { readerPushWaitMs: DEFAULT_CONFIG.readerPushWaitMs, askReaderStanding: 0 },
      { readerPushKinds: [...DEFAULT_CONFIG.readerPushKinds] },
      { syncStaleChance: DEFAULT_CONFIG.syncStaleChance },
      { probeFreshFloor: 0, probeYieldFloor: 1 },
      { anticipateOff: ["serve", "names"] },
      { confidentScore: 1.25, maxRefreshes: 0 },
    ];
    for (const config of accepted) expect(parseEngineConfig(config)).toEqual(config);
  });

  test("anticipateOff's parts are exactly the ones partner.ts reads", () => {
    const source = readFileSync(join(import.meta.dir, "../../engine/src/partner.ts"), "utf8");
    // `off` is partner.ts's local alias for `this.config.anticipateOff` in `anticipate`.
    expect(source).toContain("const off = this.config.anticipateOff;");
    const read = new Set([...source.matchAll(/\b(?:anticipateOff|off)\.includes\("(\w+)"\)/g)].map((m) => m[1]!));
    expect(read.size).toBeGreaterThan(0);
    expect([...read].sort()).toEqual([...ANTICIPATE_PARTS].sort());
  });

  test("every checked-in profile in docs/profiles parses and builds a partner (D104)", () => {
    const profiles = join(import.meta.dir, "../../../docs/profiles");
    const names = readdirSync(profiles).filter((name) => name.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const engine = engineConfig({ EDEN_ENGINE_CONFIG: join(profiles, name) });
      expect(Object.keys(engine).length).toBeGreaterThan(0);
      const partner = buildPartner({ sources: async () => [], model: null, engine });
      expect(partner.config).toEqual({ ...DEFAULT_CONFIG, ...engine });
    }
  });

  test("an unreadable or malformed file names the variable", () => {
    expect(() => engineConfig({ EDEN_ENGINE_CONFIG: join(dir, "missing.json") })).toThrow(
      /EDEN_ENGINE_CONFIG: cannot read/,
    );
    expect(() => engineConfig({ EDEN_ENGINE_CONFIG: file("bad.json", "{probes:") })).toThrow(
      /EDEN_ENGINE_CONFIG: .* is not JSON/,
    );
  });
});

describe("mcp-stdio source map (isolation)", () => {
  const a = { tenantId: "acme", userId: "alice" };
  const b = { tenantId: "acme", userId: "bob" };

  test("persists across processes and never returns user A's rows to user B", () => {
    const pathA = stdioSourceMapPath(a.tenantId, a.userId, {});
    const pathB = stdioSourceMapPath(b.tenantId, b.userId, {});
    expect(pathA).not.toBe(pathB);
    expect(pathA.startsWith(join(process.env.EDEN_HOME!, "mcp-stdio"))).toBe(true);

    const first = new SourceMap(pathA);
    first.recordMentions(a, "crm", ["Dana Lee"]);
    first.close();
    // A new process for the same user reads what the last one learned.
    const again = new SourceMap(stdioSourceMapPath(a.tenantId, a.userId, {}));
    expect(again.sourcesFor(a, "Dana Lee").map((row) => row.sourceId)).toEqual(["crm"]);
    again.close();
    // User B's process sees nothing of A's.
    const other = new SourceMap(pathB);
    expect(other.sourcesFor(b, "Dana Lee")).toEqual([]);
    other.close();
  });

  test("with a shared EDEN_SOURCE_MAP, rows stay keyed by tenant/user", () => {
    const shared = join(dir, "shared.db");
    expect(stdioSourceMapPath(a.tenantId, a.userId, { EDEN_SOURCE_MAP: shared })).toBe(shared);
    const map = new SourceMap(stdioSourceMapPath(a.tenantId, a.userId, { EDEN_SOURCE_MAP: shared }));
    map.recordMentions(a, "mail", ["Quarry Ltd"]);
    map.close();
    const forB = new SourceMap(stdioSourceMapPath(b.tenantId, b.userId, { EDEN_SOURCE_MAP: shared }));
    expect(forB.sourcesFor(b, "Quarry Ltd")).toEqual([]);
    expect(forB.sourcesFor(a, "Quarry Ltd").length).toBe(1);
    forB.close();
  });

  test("EDEN_HOME in the env passed is the home used, not process.env's", () => {
    const home = join(dir, "other-home");
    const path = stdioSourceMapPath(a.tenantId, a.userId, { EDEN_HOME: home });
    expect(path.startsWith(join(home, "mcp-stdio") + "/")).toBe(true);
    expect(path).not.toBe(stdioSourceMapPath(a.tenantId, a.userId, {}));
  });

  test("a source map that cannot be opened falls back to memory, logged, and still serves", () => {
    const logged: string[] = [];
    // A directory is not a database file: opening it throws, as an unwritable path or a held lock would.
    const map = openSourceMap(
      () => dir,
      (line) => logged.push(line),
    );
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("in memory");
    map.recordMentions(a, "crm", ["Dana Lee"]);
    expect(map.sourcesFor(a, "Dana Lee").map((row) => row.sourceId)).toEqual(["crm"]);
    map.close();
    const thrown = openSourceMap(
      () => {
        throw new Error("EACCES: mkdir");
      },
      (line) => logged.push(line),
    );
    expect(logged[1]).toContain("EACCES");
    thrown.close();
  });

  test("ids that look like paths stay inside the directory", () => {
    const path = stdioSourceMapPath("..", "..", {});
    expect(path.startsWith(join(process.env.EDEN_HOME!, "mcp-stdio") + "/")).toBe(true);
    expect(path).not.toBe(stdioSourceMapPath(a.tenantId, a.userId, {}));
  });
});
