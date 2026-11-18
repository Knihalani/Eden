/**
 * `--call-causes` (D1746): every connector call a run makes, booked by what made it. Lab-only and diagnostic: the
 * engine is not changed. The partner's and the sync's entry points are wrapped (on the instances, never the shared
 * prototypes) so that each runs inside an `AsyncLocalStorage` frame naming it; a source call reads the frames it was
 * made under and books itself to the innermost cause. `als.run` adds no await, so the order work lands in is unchanged
 * (the funnel's rows are identical with and without the flag: call-causes.test.ts and the D1746 entry).
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The causes, in the order the tables print them. */
export const CAUSES = [
  "backfill",
  "kick backfill",
  "deepen",
  "floor poll",
  "catch-up poll",
  "on-demand poll (push)",
  "on-demand poll (ask)",
  "on-demand poll (lookup)",
  "live search (push)",
  "live search (ask)",
  "live search (lookup)",
  "probe",
  "cut-behind search",
  "re-read (push verify)",
  "re-read (ask strict)",
  "re-read (other)",
  "revision poll",
  "ref notice read",
  "sweep",
  "other",
] as const;
export type Cause = (typeof CAUSES)[number];

const als = new AsyncLocalStorage<readonly string[]>();

/** The innermost frame decides, with the lookup's kind (push, ask, slow-path lookup) named for polls and searches. */
export function causeOf(frames: readonly string[], op: "list" | "search" | "fetch"): Cause {
  const has = (f: string) => frames.includes(f);
  const lookupKind = (): "push" | "ask" | "lookup" => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      if (f === "ask:push") return "push";
      if (f === "ask") return "ask";
      if (f === "lookup") return "lookup";
    }
    return "lookup";
  };
  if (op === "fetch") {
    if (has("refs")) return "ref notice read";
    if (has("verify:strict")) return "re-read (ask strict)";
    if (has("verify")) return lookupKind() === "push" ? "re-read (push verify)" : "re-read (other)";
    if (has("revision")) return "revision poll";
    return "re-read (other)";
  }
  if (op === "list") {
    if (has("revision")) return "revision poll";
    if (has("sweep")) return "sweep";
    if (has("deepen")) return "deepen";
    if (has("backfillPool")) return "kick backfill";
    if (has("backfill")) return "backfill";
    // A poll inside a poll is the catch-up a lookup's poll leaves to the background.
    if (frames.filter((f) => f === "poll").length > 1) return "catch-up poll";
    if (has("freshen")) return `on-demand poll (${lookupKind()})`;
    if (has("step")) return "floor poll";
    return "other";
  }
  if (has("probe")) return "probe";
  if (has("cutBehind")) return "cut-behind search";
  if (has("ask:push") || has("ask") || has("lookup")) return `live search (${lookupKind()})`;
  return "other";
}

type Fn = (...a: unknown[]) => unknown;

/** A world source's own id; the noise connectors (`noise-sources.ts`: `<kind>-<k>`) as one. */
export function sourceKey(id: string): string {
  return /-\d+$/.test(id) ? "noise" : id;
}

/** Wraps `obj[name]` (an own property shadowing the prototype's) so that it runs inside a frame named `frame(args)`. */
function frameIt(obj: object, name: string, frame: (args: unknown[]) => string): void {
  const o = obj as Record<string, unknown>;
  const orig = o[name];
  if (typeof orig !== "function") throw new Error(`call-causes: no method ${name}`);
  o[name] = function (this: unknown, ...args: unknown[]) {
    const at = als.getStore() ?? [];
    return als.run([...at, frame(args)], () => (orig as Fn).apply(this, args));
  };
}

/** Per-cause counts of what the connectors received, and the calls seen under each operation. */
export class CallCauses {
  readonly counts = new Map<Cause, number>();
  /** Items the sync stored new or changed (`store`'s count) under each cause: what its listings found. */
  readonly found = new Map<Cause, number>();
  /** The same two counts by cause and source (the noise connectors as one, `sourceKey`): `[calls, stored]`. */
  readonly bySource = new Map<string, [number, number]>();

  private bookSource(cause: Cause, sourceId: string, calls: number, stored: number): void {
    const key = `${cause} @ ${sourceKey(sourceId)}`;
    const at = this.bySource.get(key) ?? [0, 0];
    at[0] += calls;
    at[1] += stored;
    this.bySource.set(key, at);
  }

  /** Instruments one partner (and its sync, when it has one). */
  watchPartner(partner: object): void {
    frameIt(partner, "ask", (a) => ((a[1] as { push?: boolean } | undefined)?.push ? "ask:push" : "ask"));
    frameIt(partner, "lookup", () => "lookup");
    frameIt(partner, "probe", () => "probe");
    frameIt(partner, "consequence", () => "probe");
    frameIt(partner, "searchCutBehind", () => "cutBehind");
    frameIt(partner, "verifyItems", (a) => (a[3] ? "verify:strict" : "verify"));
    frameIt(partner, "pollRevised", () => "revision");
    frameIt(partner, "sourceRefs", () => "refs");
    const sync = (partner as { sync?: object | null }).sync;
    if (sync) {
      for (const m of ["backfill", "backfillPool", "deepen", "sweep", "freshen", "step", "poll"]) {
        frameIt(sync, m, () => m);
      }
      const o = sync as Record<string, unknown>;
      const store = o.store as Fn;
      o.store = async (...args: unknown[]) => {
        const n = (await store.apply(sync, args)) as number;
        if (n > 0) {
          const cause = causeOf(als.getStore() ?? [], "list");
          this.found.set(cause, (this.found.get(cause) ?? 0) + n);
          this.bookSource(cause, (args[1] as { id: string }).id, 0, n);
        }
        return n;
      };
    }
  }

  /** Wraps a source's calls so that each is booked; call before the run makes any. */
  watchSource(source: object): void {
    const o = source as Record<string, unknown>;
    for (const op of ["list", "search", "fetch"] as const) {
      const orig = o[op];
      if (typeof orig !== "function") continue;
      o[op] = (...args: unknown[]) => {
        const cause = causeOf(als.getStore() ?? [], op);
        this.counts.set(cause, (this.counts.get(cause) ?? 0) + 1);
        this.bookSource(cause, (source as { id: string }).id, 1, 0);
        return (orig as Fn).apply(source, args);
      };
    }
  }

  total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }

  add(other: Record<string, number>): void {
    for (const [k, v] of Object.entries(other)) {
      // `src:<cause> @ <source>` keys carry `bySource` as calls*1e6 + stored (one number a key in the JSON).
      if (k.startsWith("src:")) {
        const at = this.bySource.get(k.slice(4)) ?? [0, 0];
        at[0] += Math.floor(v / 1e6);
        at[1] += v % 1e6;
        this.bySource.set(k.slice(4), at);
        continue;
      }
      // `found:<cause>` keys carry what the cause's listings stored.
      const into = k.startsWith("found:") ? this.found : this.counts;
      const c = (k.startsWith("found:") ? k.slice(6) : k) as Cause;
      into.set(c, (into.get(c) ?? 0) + v);
    }
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries([
      ...CAUSES.filter((c) => this.counts.has(c)).map((c) => [c, this.counts.get(c)!] as const),
      ...CAUSES.filter((c) => this.found.has(c)).map((c) => [`found:${c}`, this.found.get(c)!] as const),
      ...[...this.bySource].map(([k, [calls, stored]]) => [`src:${k}`, calls * 1e6 + stored] as const),
    ]);
  }

  /** By cause and source: calls and items stored, the causes that made calls only. */
  detail(units: number, unit: string): string {
    const rows = [...this.bySource]
      .filter(([, [calls]]) => calls > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, [calls, stored]]) => {
        const per = (calls / Math.max(1, units)).toFixed(3).padStart(9);
        return `  ${k.padEnd(40)} ${String(calls).padStart(8)}  ${per}/${unit}  stored ${stored}`;
      });
    return ["call causes by source (D1746):", ...rows].join("\n");
  }

  /** One table: each cause's calls, per `unit` (tasks or user-days), and share. */
  table(units: number, unit: string): string {
    const total = this.total();
    const rows = CAUSES.filter((c) => (this.counts.get(c) ?? 0) > 0).map((c) => {
      const n = this.counts.get(c)!;
      const per = (n / Math.max(1, units)).toFixed(3).padStart(9);
      const share = ((100 * n) / Math.max(1, total)).toFixed(1).padStart(5);
      const found = this.found.get(c) ?? 0;
      return `  ${c.padEnd(26)} ${String(n).padStart(8)}  ${per}/${unit}  ${share}%  stored ${found}`;
    });
    return [
      `call causes (D1746): ${total} connector calls, ${(total / Math.max(1, units)).toFixed(3)}/${unit} over ${units} ${unit}s`,
      ...rows,
    ].join("\n");
  }
}

/** `bun packages/sim/src/lab/call-causes.ts FILE [unit]`: the merged table of a run's process lines. */
if (import.meta.main) {
  const [file, unit = "task"] = process.argv.slice(2);
  if (!file) {
    console.error("usage: call-causes.ts FILE [unit]");
    process.exit(2);
  }
  const all = new CallCauses();
  let units = 0;
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as { tasks?: number; units?: number; counts: Record<string, number> };
    units += row.units ?? row.tasks ?? 0;
    all.add(row.counts);
  }
  console.log(all.table(units, unit));
  console.log(all.detail(units, unit));
}
