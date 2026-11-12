import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, PARTS, type Part } from "@eden/engine";
import { FakeModel } from "@eden/llm";
import type { ListPage, Source } from "@eden/sources";
import { edenHome } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { buildPartner, openSourceMap } from "./build";
import { stdioSourceMapPath } from "./config";
import { engineConfig, parseEngineConfig } from "./engine-config";
import { DEFAULT_USD_PER_TENANT_DAY, modelRolesFromEnv, NO_MODELS } from "./models";

const dir = mkdtempSync(join(edenHome(), "engine-config-"));
const file = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

describe("EDEN_ENGINE_CONFIG (D103)", () => {
  test("unset: the partner runs on the default exactly", () => {
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
        probeCalls: 4,
        probeOff: ["calendar"],
      }),
    );
    const engine = engineConfig({ EDEN_ENGINE_CONFIG: path });
    expect(engine).toEqual({
      probes: true,
      compactAsk: true,
      askItemBytes: 240,
      probeCalls: 4,
      probeOff: ["calendar"],
    });
    const partner = buildPartner({ sources: async () => [], model: null, engine });
    expect(partner.config).toEqual({ ...DEFAULT_CONFIG, ...engine });
  });

  test("card, intent, reader and sync keys are accepted: the servers wire them, or they are inert by design (D112)", () => {
    // Default minus a part, and trials of the parts' numbers, all parse.
    const accepted: Record<string, unknown>[] = [
      { cards: false, cardsEconomy: false, intent: false },
      { askReader: false, readerPush: false, readerGate: false },
      { sync: false, syncPollBehind: false, syncPollPageSize: 0, readerPushBehind: false },
      { askReaderPool: 20, askReaderItemChars: 400, readerPushWaitMs: 5, readerPushKinds: ["blocks"] },
    ];
    for (const config of accepted) expect(parseEngineConfig(config)).toEqual(config);
  });

  test("the model roles are wired only when given; without them the same default runs with no model (D112)", () => {
    const none = buildPartner({ sources: async () => [], model: null }) as unknown as { deps: Record<string, unknown> };
    expect(none.deps.cards).toBeUndefined();
    expect(none.deps.reader).toBeUndefined();
    expect(none.deps.model).toBeNull();
    const model = new FakeModel(() => "{}");
    const roles = { reader: model, cards: model, cardsRetry: null, usdPerTenantDay: 1 };
    const both = buildPartner({ sources: async () => [], models: roles }) as unknown as {
      deps: Record<string, unknown>;
      config: typeof DEFAULT_CONFIG;
    };
    expect(both.deps.cards).toBeDefined();
    expect(both.deps.reader).toBeDefined();
    // No judge: the measured default ran without one.
    expect(both.deps.model).toBeNull();
    expect(both.config).toEqual(DEFAULT_CONFIG);
    // An embedding's judge with no roles is charged under the default tenant cap, not refused by a 0 cap.
    const judged = buildPartner({ sources: async () => [], model }) as unknown as {
      deps: { budget: { reserve(user: string, session: string, usd: number): unknown } };
    };
    expect(judged.deps.budget.reserve("acme/u1", "s1", 0.001)).not.toBeNull();
    // Default minus a part: its role is not built, so it costs nothing.
    const minus = buildPartner({ sources: async () => [], models: roles, engine: { cards: false, askReader: false } });
    expect((minus as unknown as { deps: Record<string, unknown> }).deps.cards).toBeUndefined();
    expect((minus as unknown as { deps: Record<string, unknown> }).deps.reader).toBeUndefined();
  });

  test("sync over per-user sources: a user's listable source is listed for that user only (D108, D112)", async () => {
    const listed: string[] = [];
    const lister = (owner: string): Source => ({
      id: "mail",
      kind: "mcp",
      description: "mail",
      async search() {
        return [];
      },
      async list(scope, _cursor, _limit, _signal): Promise<ListPage> {
        listed.push(`${owner} for ${scope.tenantId}/${scope.userId}`);
        return {
          items: [
            {
              id: `mail:${owner}`,
              sourceId: "mail",
              ref: owner,
              title: `Note for ${owner}`,
              text: "Globex renewal moved",
            },
          ],
          next: null,
        };
      },
    });
    const partner = buildPartner({
      sources: async (scope) => [lister(scope.userId)],
      model: null,
      queryPlanner: "off",
    });
    partner.stopSync();
    for (const userId of ["alice", "bob"]) {
      const scope = { tenantId: "acme", userId, sessionId: `s-${userId}` };
      await partner.observe({ kind: "session_start", ...scope, at: 0 } as never);
    }
    // One background round (the timer's work): each active user's listable source is backfilled.
    expect(partner.sync).not.toBeNull();
    await partner.sync!.tick();
    expect(listed).toContain("alice for acme/alice");
    expect(listed).toContain("bob for acme/bob");
    // Each user's source was listed for its own user and no other.
    for (const line of listed) expect(line === "alice for acme/alice" || line === "bob for acme/bob").toBe(true);
    await partner.forget({ tenantId: "acme", userId: "alice" } as never);
  });

  test("model roles from the environment: none without a key, a tenant cap that must be a number", () => {
    expect(modelRolesFromEnv({})).toEqual({ ...NO_MODELS, usdPerTenantDay: DEFAULT_USD_PER_TENANT_DAY });
    const roles = modelRolesFromEnv({ OPENROUTER_API_KEY: "k", EDEN_MODEL_USD_PER_TENANT_DAY: "3" });
    expect(roles.reader).not.toBeNull();
    expect(roles.cards).not.toBeNull();
    expect(roles.usdPerTenantDay).toBe(3);
    expect(() => modelRolesFromEnv({ EDEN_MODEL_USD_PER_TENANT_DAY: "lots" })).toThrow(
      /EDEN_MODEL_USD_PER_TENANT_DAY must be/,
    );
  });

  test("EDEN_MODEL_CACHE (D1193's trial): cache breakpoints only when set to on", () => {
    const seen: Record<string, unknown>[] = [];
    const make = (o: Record<string, unknown>) => {
      seen.push(o);
      return { id: "fake", chat: async () => ({}) } as never;
    };
    modelRolesFromEnv({ OPENROUTER_API_KEY: "k" }, make as never);
    expect(seen.every((o) => o.anthropicCache === undefined)).toBe(true);
    seen.length = 0;
    modelRolesFromEnv({ OPENROUTER_API_KEY: "k", EDEN_MODEL_CACHE: "on" }, make as never);
    expect(seen.length).toBe(3);
    expect(seen.every((o) => o.anthropicCache === true)).toBe(true);
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
    expect(() => parseEngineConfig([])).toThrow(/must be a JSON object/);
  });

  test("settings that would do nothing or break a feature are refused, naming the key (audit 2026-11-03b)", () => {
    const refused: [Record<string, unknown>, string][] = [
      // A typo names no kind.
      [{ readerPushKinds: ["blockz"] }, "readerPushKinds"],
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
    expect(() => parseEngineConfig({ readerPushKinds: ["blocks", "blockz"] })).toThrow(
      /"readerPushKinds" has "blockz"/,
    );
    // Legal: nothing, 0 where 0 means off, defaults of dependency-only keys, chances at the bounds, real parts.
    const accepted: Record<string, unknown>[] = [
      {},
      { syncPollPageSize: 0, syncPageSize: DEFAULT_CONFIG.syncPageSize },
      { readerPushWaitMs: DEFAULT_CONFIG.readerPushWaitMs, askReaderItemChars: DEFAULT_CONFIG.askReaderItemChars },
      { readerPushKinds: [...DEFAULT_CONFIG.readerPushKinds] },
      { syncStaleChance: DEFAULT_CONFIG.syncStaleChance },
      { probeFreshFloor: 0, probeYieldFloor: 1 },
      { confidentScore: 1.25, refreshAfterMs: 0 },
    ];
    for (const config of accepted) expect(parseEngineConfig(config)).toEqual(config);
  });

  test("every checked-in profile in docs/profiles is the default minus a part, parses and builds a partner", () => {
    const profiles = join(import.meta.dir, "../../../docs/profiles");
    const names = readdirSync(profiles).filter((name) => name.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const engine = engineConfig({ EDEN_ENGINE_CONFIG: join(profiles, name) });
      // `minus-<part>.json` holds exactly PARTS[part] (D112): the only ablation there is.
      const part = /^minus-(\w+)\.json$/.exec(name)?.[1];
      expect(part !== undefined && part in PARTS).toBe(true);
      expect(engine).toEqual(PARTS[part as Part]);
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
