#!/usr/bin/env bun
/**
 * RealUse-1 part D, T5: does an ask say "could not reach" honestly when connectors fail (D127)? No model.
 *
 * For each fault profile, each of `--users` sim users (their own world, seeded as quality.ts seeds them) gets a fresh
 * ContextPartner (DEFAULT_CONFIG, no model) over REALISTIC sim sources with the profile's overrides, and asks every
 * ask question of its generated sessions. Each answer is classed against the statuses the ask reports
 * (`AskResponse.sources`): an ask where a chosen source did not answer (status not ok/cached/stale/local) is honest
 * when its text says "Could not reach" (or "not an all-clear"); a false all-clear is the text "Nothing in the
 * connected sources." with such a source. Recall@5 of the asks' must facts is reported beside, as quality-cli does.
 *
 *   bun packages/sim/lab/realuse-1/D/probes/ask-honesty-probe.ts [--users 8] [--json out.json]
 */
import { Budget } from "@eden/llm";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { buildSessions, buildWorld, REALISTIC, simSources, type ProfileSet, type SourceProfile } from "../../../../src";
import { withOverrides } from "../../../../src/sources";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const USERS = Number(opt("--users", "8"));
const ANSWERED = new Set(["ok", "cached", "stale", "local"]);

const all = (p: Partial<SourceProfile>) => Object.fromEntries(Object.keys(REALISTIC).map((k) => [k, p]));
/**
 * Rate limits act only in real time (`SimSource.take` returns true at time scale 0), so the `rate-*` profiles run at
 * `TIME` (0.05: latencies and the token bucket's clock 20x compressed) with quality.ts's scaled source timeout.
 */
const TIME = 0.05;
const FAULTS: Record<string, Record<string, Partial<SourceProfile>>> = {
  healthy: {},
  "errors-10pct": all({ errorRate: 0.1 }),
  "errors-30pct": all({ errorRate: 0.3 }),
  "gmail-down": { gmail: { errorRate: 1 } },
  "gmail+calendar-down": { gmail: { errorRate: 1 }, calendar: { errorRate: 1 } },
  "all-down": all({ errorRate: 1 }),
  "rate-1-per-s": all({ ratePerSec: 1 }),
  "rate-0.2-per-s": all({ ratePerSec: 0.2 }),
  "rate-0.2-per-s+errors-10pct": all({ ratePerSec: 0.2, errorRate: 0.1 }),
};

interface Row {
  profile: string;
  timeScale: number;
  asks: number;
  recallAt5: number;
  withUnreached: number;
  honest: number;
  falseAllClear: number;
  silentAboutFailure: number;
  allClearWhenHealthy: number;
  statuses: Record<string, number>;
  example?: string;
}

const rows: Row[] = [];
for (const [name, over] of Object.entries(FAULTS)) {
  const profiles: ProfileSet = withOverrides(REALISTIC, over);
  const time = name.startsWith("rate-") ? TIME : 0;
  const row: Row = {
    profile: name,
    timeScale: time,
    asks: 0,
    recallAt5: 0,
    withUnreached: 0,
    honest: 0,
    falseAllClear: 0,
    silentAboutFailure: 0,
    allClearWhenHealthy: 0,
    statuses: {},
  };
  let must = 0;
  let hits = 0;
  for (let u = 0; u < USERS; u++) {
    const seed = 1;
    const world = buildWorld({ seed: seed * 1_000 + u });
    const { asks } = buildSessions(world, { seed: seed * 7_919 + u, sessions: 20, agentToolRate: 0.4 });
    const sources = simSources(world, profiles, time, seed + u);
    const byId = new Map(world.items.map((i) => [i.id, i]));
    // Questions a minute apart, as quality.ts spaces them (its draw is log-normal around a minute).
    let clock = world.now;
    const partner = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(":memory:", { seed: seed + u }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      ...(time > 0 ? { config: { sourceTimeoutMs: 1_500 * time } } : {}),
    });
    const who = { tenantId: "probe", userId: `u${u}` };
    for (const c of asks) {
      clock += 60_000;
      const res = await partner.ask({ ...who, sessionId: "ask", question: c.question, maxItems: 5 });
      row.asks++;
      const ids = res.citations.map((x) => x.itemId);
      for (const f of c.must) {
        must++;
        if (ids.some((id) => byId.get(id)?.facts.includes(f))) hits++;
      }
      const st = res.sources ?? [];
      for (const s of st) row.statuses[s.status] = (row.statuses[s.status] ?? 0) + 1;
      const unreached = st.some((s) => !ANSWERED.has(s.status));
      const saysUnreached = /Could not reach|not an all-clear/.test(res.answer);
      const allClear = res.answer.trim() === "Nothing in the connected sources.";
      if (unreached) {
        row.withUnreached++;
        if (saysUnreached) row.honest++;
        else if (allClear) row.falseAllClear++;
        else row.silentAboutFailure++;
        if (!row.example && saysUnreached) row.example = res.answer.split("\n").at(-1);
      } else if (allClear) row.allClearWhenHealthy++;
    }
  }
  row.recallAt5 = Math.round((hits / Math.max(1, must)) * 1000) / 1000;
  rows.push(row);
  console.error(JSON.stringify(row));
}
console.log(JSON.stringify(rows, null, 2));
if (argv.includes("--json")) await Bun.write(opt("--json", ""), JSON.stringify(rows, null, 1));
