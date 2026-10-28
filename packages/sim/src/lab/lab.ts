/**
 * The connector lab: real open-source MCP servers over real backends, seeded with a simulated world, so a real
 * connector's search semantics meet known ground truth (docs/plans/query-planner.md, tier 3).
 *
 * For each connector it measures, per query variant, how often a lookup returns an item that holds a fact the case
 * needs (reach), how often it returns nothing, how much it returns and how fast. The variants are instrumentation for
 * choosing what a planner should try, not a planner: every case runs every variant.
 *
 * Every seeded item carries its world key (`gmail-mail-12`) in an id, path or name field the server echoes, so a
 * result maps back to world items exactly.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { contentTerms, extractEntities } from "@eden/engine";
import { Vocab } from "@eden/primitives";
import { McpSource, QueryPlanner, type PlannerOptions, type SearchQuery, type Source } from "@eden/sources";
import { buildSessions } from "../sessions";
import type { World, WorldItem } from "../world";

export interface LabCase {
  text: string;
  /** Facts the case needs; any one of them reached counts. */
  must: string[];
  ok: string[];
}

export interface LabConnector {
  name: string;
  /** What the server's search does, as read in its code (docs/research/connectors.md). */
  semantics: string;
  /** Which world items this kind of service would hold. */
  accepts(item: WorldItem): boolean;
  /** Starts the backend and writes the accepted items through its write API or storage. */
  setup(items: WorldItem[], world: World): Promise<void>;
  transport(): Transport;
  searchTool: { name: string; args(text: string, limit: number): Record<string, unknown> };
  /** World keys a raw tool result names, when the server does not echo the key itself (default: `keysIn`). */
  identify?(raw: string): string[];
  /** Set when the server does not annotate its search tool read-only; checked by hand (D7). */
  trustedReadTools?: string[];
  teardown(): Promise<void>;
}

export const worldKey = (item: Pick<WorldItem, "sourceId" | "ref">) => `${item.sourceId}-${item.ref}`;

// Refs are `kind-N`, with a `-copy` or `-dup` suffix on near-duplicates, which must not count as their original.
const KEY = /\b(?:gmail|calendar|drive|crm|slack)-[a-z]+-\d+(?:-(?:copy|dup))?\b/g;

/** World keys named in a result, in order of first appearance. */
export function keysIn(text: string): string[] {
  return [...new Set(text.match(KEY) ?? [])];
}

/** Ask cases and need turns with text, deduplicated by text. */
export function labCases(world: World, seed: number, sessions: number): LabCase[] {
  const built = buildSessions(world, { seed, sessions });
  const out = new Map<string, LabCase>();
  for (const a of built.asks) out.set(a.question, { text: a.question, must: a.must, ok: a.ok });
  for (const s of built.sessions) {
    for (const t of s.tasks) {
      for (const turn of t.turns) {
        if (turn.label.kind !== "need" || !("text" in turn.event)) continue;
        const text = turn.event.text;
        if (!out.has(text)) out.set(text, { text, must: turn.label.must, ok: turn.label.ok });
      }
    }
  }
  return [...out.values()];
}

export type VariantName = "question" | "terms" | "entities" | "each-entity" | "entity+term" | "planner";
/**
 * Fixed variants send the same phrasing for every case. `planner` is Eden's `QueryPlanner` sent the cue Eden builds
 * (terms and entities), learning online over the cases in order, as it would over one user's lookups.
 */
export const VARIANTS: VariantName[] = ["question", "terms", "entities", "each-entity", "entity+term", "planner"];

/**
 * The query strings a variant sends for one case (several for each-entity), or none when it does not apply.
 * `terms` is what Eden sends today (the cue's distinct content terms); `question` is what an integrator passing the
 * agent's words verbatim sends. `df` ranks terms by rarity in the user's own items.
 */
export function variantQueries(v: VariantName, text: string, df: Map<string, number>, vocab: Vocab): string[] {
  const terms = [...new Set(contentTerms(text, vocab))].slice(0, 16);
  const entities = extractEntities(text).slice(0, 8);
  switch (v) {
    case "question":
      return [text];
    case "terms":
      return terms.length ? [terms.join(" ")] : [];
    case "entities":
      return entities.length ? [entities.join(" ")] : [];
    case "each-entity":
      return entities.slice(0, 3);
    case "entity+term": {
      if (!entities.length) return [];
      const inEntity = new Set(contentTerms(entities.join(" "), vocab));
      const rest = terms.filter((t) => !inEntity.has(t)).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
      return rest.length ? [`${entities[0]} ${rest[0]}`] : [];
    }
    case "planner":
      return []; // Chosen per case by the planner, not fixed.
  }
}

export interface VariantStats {
  /** Cases the variant applies to (entity variants need an entity in the cue). */
  cases: number;
  calls: number;
  /** Cases where the variant reached a needed item. */
  hits: number;
  /** hits / cases: how well the variant does where it applies. */
  reach: number;
  /**
   * hits / every case the connector can answer, counting a case the variant does not apply to as a miss: the figure
   * to compare variants by, since they are then scored on the same cases.
   */
  reachAll: number;
  empty: number;
  errors: number;
  /** Mean distinct world items a case's calls returned, counting at most `limit` per call, as a client would keep. */
  returned: number;
  /**
   * Mean results the servers sent per case before the cap, summed over the case's calls (an item two calls both
   * return counts twice): what servers that ignore or lack a limit send.
   */
  returnedRaw: number;
  /** Of returned items, the share holding a fact the case needs or may use. */
  relevantShare: number;
  latencyMs: { p50: number; p95: number };
}

export interface ConnectorReport {
  connector: string;
  semantics: string;
  seeded: number;
  seedMs: number;
  /** Cases with at least one needed item in this connector. */
  cases: number;
  variants: Record<string, VariantStats>;
  /** A sample of call failures, for diagnosis. */
  errorSamples: string[];
  /** Of items `McpSource` made from results, the share with no id of their own (a positional or content-hash ref). */
  refFallback: number;
  /**
   * Of distinct item ids `McpSource` produced over the run (among items naming a world key), the share given to more
   * than one world item. The partner's cache and ledger key items by id, so each such id is items overwriting each
   * other. The same item with a different excerpt per query is not a collision.
   */
  idCollisions: number;
  /** Of world items seen, the share that got more than one item id: the same item counted as new more than once. */
  idSplits: number;
  /** The planner variant: how often it led with each shape, and its reach over the second half of the cases. */
  planner: { shapes: Record<string, number>; reachLate: number; casesLate: number } | null;
}

/**
 * Wraps a transport to keep the raw text of the last tool result, so results are scored from what the server said,
 * not from what `toItems` kept of it.
 */
export function tap(inner: Transport, onResult: (text: string, isError: boolean) => void): Transport {
  const t: Transport = {
    start: () => inner.start(),
    send: (m, o) => inner.send(m, o),
    close: () => inner.close(),
  };
  inner.onclose = () => t.onclose?.();
  inner.onerror = (e) => t.onerror?.(e);
  inner.onmessage = (m: JSONRPCMessage, extra) => {
    const result = (m as { result?: { content?: unknown; isError?: boolean } }).result;
    if (Array.isArray(result?.content)) onResult(JSON.stringify(result.content), result.isError === true);
    t.onmessage?.(m, extra);
  };
  return t;
}

const quantile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
};

export async function runConnector(
  c: LabConnector,
  world: World,
  cases: LabCase[],
  options: { limit?: number; timeoutMs?: number; variants?: VariantName[]; planner?: PlannerOptions } = {},
): Promise<ConnectorReport> {
  const limit = options.limit ?? 10;
  const items = world.items.filter((i) => c.accepts(i));
  const holders = new Map<string, Set<string>>(); // fact → world keys holding it
  for (const i of items)
    for (const f of i.facts) (holders.get(f) ?? holders.set(f, new Set()).get(f)!).add(worldKey(i));
  const factsOf = new Map(items.map((i) => [worldKey(i), new Set(i.facts)]));
  const vocab = new Vocab();
  const df = new Map<string, number>();
  for (const i of items)
    for (const t of new Set(contentTerms(`${i.title} ${i.text}`, vocab))) df.set(t, (df.get(t) ?? 0) + 1);

  let raw = "";
  let rawError = false;
  let made = 0;
  let fallback = 0;
  const worldById = new Map<string, Set<string>>();
  const idsByWorld = new Map<string, Set<string>>();
  let seedMs = 0;
  const source = new McpSource({
    id: c.name,
    description: c.semantics,
    transport: () =>
      tap(c.transport(), (text, isError) => {
        raw = text;
        rawError = isError;
      }),
    searchTool: { name: c.searchTool.name, args: (q: SearchQuery) => c.searchTool.args(q.text, q.limit) },
    trustedReadTools: c.trustedReadTools,
  });
  const scope = { tenantId: "lab", userId: "lab-user" };
  const applicable = cases.filter((k) => k.must.some((f) => holders.has(f)));
  const variants: Record<string, VariantStats> = {};
  const errorSamples: string[] = [];
  const r = (x: number) => Math.round(x * 1_000) / 1_000;
  const shapesLed: Record<string, number> = {};
  const late = { n: 0, hits: 0 };
  try {
    // Inside the try: a setup that fails half-way still has its containers and seeded files removed.
    const t0 = performance.now();
    await c.setup(items, world);
    seedMs = Math.round(performance.now() - t0);
    // Every call of a case goes through here, whoever chose it: results are scored from the raw server answer.
    let caseKeys = new Set<string>();
    let caseRaw = 0;
    let caseErrors = 0;
    let lat: number[] = [];
    let variant = "";
    const counted: Source = {
      id: c.name,
      kind: "lab",
      description: c.semantics,
      search: async (q: SearchQuery) => {
        const s = performance.now();
        raw = "";
        rawError = false;
        try {
          const res = await source.search({ ...q, limit }, AbortSignal.timeout(options.timeoutMs ?? 30_000));
          // McpSource turns a tool error into no items; count it as the error it is.
          if (rawError) {
            caseErrors++;
            if (errorSamples.length < 5) errorSamples.push(`${variant}: tool error: ${raw.slice(0, 300)}`);
          }
          const keys = c.identify ? c.identify(raw) : keysIn(raw);
          caseRaw += keys.length;
          // A client keeps at most `limit` results per call, in the server's order, whatever the server sends.
          for (const key of keys.slice(0, limit)) caseKeys.add(key);
          made += res.length;
          fallback += res.filter((it) => /^(?:block|eden-h)-/.test(it.ref)).length;
          // Which world item each produced item is (the first world key it names), to find ids given to two items.
          for (const it of res) {
            const key = keysIn(`${it.ref} ${it.title} ${it.url ?? ""} ${it.text}`)[0];
            if (!key) continue;
            (worldById.get(it.id) ?? worldById.set(it.id, new Set()).get(it.id)!).add(key);
            (idsByWorld.get(key) ?? idsByWorld.set(key, new Set()).get(key)!).add(it.id);
          }
          return res;
        } catch (e) {
          caseErrors++;
          if (errorSamples.length < 5) errorSamples.push(`${variant}: ${String(e).slice(0, 300)}`);
          return [];
        } finally {
          lat.push(performance.now() - s);
        }
      },
    };
    const planner = new QueryPlanner({ seed: 11, ...options.planner });
    // `counted` applies its own per-call timeout.
    const never = new AbortController().signal;
    for (const v of options.variants ?? VARIANTS) {
      variant = v;
      lat = [];
      const t = { n: 0, calls: 0, hits: 0, empty: 0, errors: 0, returned: 0, returnedRaw: 0, rel: 0 };
      for (let ki = 0; ki < applicable.length; ki++) {
        const k = applicable[ki]!;
        caseKeys = new Set();
        caseRaw = 0;
        caseErrors = 0;
        const callsBefore = lat.length;
        if (v === "planner") {
          const terms = [...new Set(contentTerms(k.text, vocab))].slice(0, 16).join(" ");
          const entities = extractEntities(k.text).slice(0, 8);
          if (!terms && !entities.length) continue;
          const res = await planner.search(counted, { scope, text: terms, entities, limit }, never);
          shapesLed[res.shapes[0] ?? "none"] = (shapesLed[res.shapes[0] ?? "none"] ?? 0) + 1;
        } else {
          const queries = variantQueries(v, k.text, df, vocab);
          if (!queries.length) continue;
          for (const text of queries) await counted.search({ scope, text, entities: [], limit }, never);
        }
        t.n++;
        t.calls += lat.length - callsBefore;
        t.errors += caseErrors;
        const needed = new Set(k.must.flatMap((f) => [...(holders.get(f) ?? [])]));
        const useful = new Set([...k.must, ...k.ok]);
        const hit = [...caseKeys].some((key) => needed.has(key));
        if (hit) t.hits++;
        if (v === "planner" && ki >= applicable.length / 2) {
          late.n++;
          if (hit) late.hits++;
        }
        if (!caseKeys.size) t.empty++;
        t.returned += caseKeys.size;
        t.returnedRaw += caseRaw;
        for (const key of caseKeys) if ([...(factsOf.get(key) ?? [])].some((f) => useful.has(f))) t.rel++;
      }
      variants[v] = {
        cases: t.n,
        calls: t.calls,
        hits: t.hits,
        reach: r(t.hits / Math.max(1, t.n)),
        reachAll: r(t.hits / Math.max(1, applicable.length)),
        empty: r(t.empty / Math.max(1, t.n)),
        errors: t.errors,
        returned: Math.round((t.returned / Math.max(1, t.n)) * 10) / 10,
        returnedRaw: Math.round((t.returnedRaw / Math.max(1, t.n)) * 10) / 10,
        relevantShare: r(t.rel / Math.max(1, t.returned)),
        latencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
      };
    }
  } finally {
    await source.close().catch(() => {});
    await c.teardown().catch(() => {});
  }
  return {
    connector: c.name,
    semantics: c.semantics,
    seeded: items.length,
    seedMs,
    cases: applicable.length,
    variants,
    errorSamples,
    refFallback: Math.round((fallback / Math.max(1, made)) * 1_000) / 1_000,
    planner: { shapes: shapesLed, reachLate: r(late.hits / Math.max(1, late.n)), casesLate: late.n },
    idSplits:
      Math.round(([...idsByWorld.values()].filter((t) => t.size > 1).length / Math.max(1, idsByWorld.size)) * 1_000) /
      1_000,
    idCollisions:
      Math.round(([...worldById.values()].filter((t) => t.size > 1).length / Math.max(1, worldById.size)) * 1_000) /
      1_000,
  };
}
