import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@eden/engine";
import { edenHome } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { buildPartner, openSourceMap } from "./build";
import { stdioSourceMapPath } from "./config";
import { engineConfig, parseEngineConfig } from "./engine-config";

const dir = mkdtempSync(join(edenHome(), "engine-config-"));
const file = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

describe("EDEN_ENGINE_CONFIG (D101)", () => {
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

  test("askWithModel: the file's value holds when the option is unset; an explicit option wins, as before D101", () => {
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
