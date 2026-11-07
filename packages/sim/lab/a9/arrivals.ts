// A9 (docs/research/a9-ahead.md): a $0 screen of `planConflict` under ordinary new-item traffic, which the live lab's
// static worlds never send. One user per seed over `--days` days (pi-ab's `--days` plan and world), Eden alone (no
// agent, no model: cards replayed from `--cards`, a miss left uncarded): a share of the world's items that no request
// planted is held back and arrives over the days, `--per-gap` before each request on average (pi-ab's `--push payload`:
// `sourceItems`), and each request is observed as the user's turn. Every plan packet here carries a background item
// no request is about (the suites' facts are only the planted items): its count is planConflict's false-fire volume.
//   bun packages/sim/lab/a9/arrivals.ts --cards .local/a9/cards-all.jsonl [--seeds 41,42] [--days 8] [--per-gap 2]
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { CardEnricher, ContextPartner, DEFAULT_CONFIG, ItemCache } from "@eden/engine";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { Rng } from "../../src/rng";
import { simSources } from "../../src/sources";
import { REALISTIC } from "../../src/sources";
import { DiskCardMaker } from "../../src/lab/cards-disk";
import { parseMix, planUser, suiteTemplates, userWorldOf } from "../../src/lab/pi-user";
import { parseSuites } from "../../src/lab/suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const CARDS = opt("cards", "");
if (!CARDS) throw new Error("--cards FILE is required (the replayed cards; no model is called)");
const SEEDS = opt("seeds", "41,42").split(",").map(Number);
const DAYS = Number(opt("days", "8"));
const PER_GAP = Number(opt("per-gap", "2"));
const GAP_MS = 10 * 60_000;
const NIGHT_MS = 2 * 3_600_000;
const disk = new DiskCardMaker(CARDS, undefined, { out: "/dev/null" });

for (const seed of SEEDS) {
  const plan = planUser(seed, suiteTemplates(seed, parseSuites("train")), {
    days: DAYS,
    size: [12, 20],
    mix: parseMix("1:1:8"),
  });
  const u = userWorldOf(seed, plan);
  const world = { ...u.world, items: u.world.items.map((i) => ({ ...i })) };
  const planted = new Set(u.tasks.flatMap((t) => (t.planted ? [t.planted] : [])));
  const rng = new Rng(seed * 104_729 + 9);
  const want = Math.round(PER_GAP * u.tasks.length);
  const pool = world.items.filter((i) => !planted.has(i.id));
  const arrivals = rng.sample(pool, Math.min(want, pool.length));
  const held = new Set(arrivals.map((i) => i.id));
  world.items = world.items.filter((i) => !held.has(i.id));
  const sources = simSources(world, REALISTIC, 0, seed);
  for (const s of sources) s.notifies = true;
  let clock = world.now;
  const cards = new CardEnricher({
    maker: new DiskCardMaker(CARDS, undefined, { out: "/dev/null", shared: disk }),
    budget: new Budget(),
    now: () => clock,
  });
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    planner: new QueryPlanner({ seed }),
    now: () => clock,
    config: { ...DEFAULT_CONFIG, planConflict: true },
    cards,
  });
  const scope = { tenantId: "a9", userId: `w${seed}` };
  const sync = partner.sync!;
  const start = clock;
  clock -= 30 * 60_000;
  sync.track(scope, clock);
  for (let i = 0; i < 120 && !sync.warm(scope); i++) {
    await sync.tick();
    clock += 60_000;
  }
  clock = start;
  await cards.idle();
  // Arrivals spread evenly over the gaps before requests 2..n (none before the first: nothing has acted yet).
  const slots = new Map<number, typeof arrivals>();
  arrivals.forEach((it, k) => {
    const at = 1 + Math.floor((k * (u.tasks.length - 1)) / arrivals.length);
    slots.set(at, [...(slots.get(at) ?? []), it]);
  });
  const reasons = new Map<string, number>();
  let planItems = 0;
  let afterPlan = 0;
  let arrived = 0;
  let k = 0;
  for (const [d, size] of u.daySizes.entries()) {
    const sessionId = `w${seed}:user:day${d}`;
    if (d > 0) clock += NIGHT_MS;
    for (let j = 0; j < size; j++, k++) {
      const task = u.tasks[k]!;
      clock += GAP_MS;
      for (const it of slots.get(k) ?? []) {
        world.items.push({ ...it, updatedAt: clock });
        const src = sources.find((s) => s.id === it.sourceId)!;
        src.reindex();
        arrived += await partner.sourceItems(
          scope,
          src.id,
          src.listAll().filter((i) => i.id === it.id),
        );
      }
      await cards.idle();
      const ev = { ...scope, sessionId, at: clock, kind: "user_message", text: task.text } as AgentEvent;
      const r = await partner.observe(ev, { waitMs: 3_000 });
      const got = [...(r.injection ? [r.injection] : []), ...partner.takePending({ ...scope, sessionId })];
      let plans = 0;
      for (const p of got) {
        const why = p.reason.split(":")[0]!;
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
        if (why === "plan") {
          plans++;
          planItems += p.citations.length;
        }
      }
      if (plans > 0) afterPlan++;
    }
    await partner.observe({ ...scope, sessionId, at: clock, kind: "session_end" } as AgentEvent);
  }
  const n = u.tasks.length;
  console.log(
    `w${seed}: ${n} requests over ${u.daySizes.length} days; ${arrivals.length} background items held back, ` +
      `${arrived} stored new on arrival; requests with a plan packet ${afterPlan} (${((100 * afterPlan) / n).toFixed(1)}%), ` +
      `plan packets ${reasons.get("plan") ?? 0}, plan items ${planItems} (${(planItems / u.daySizes.length).toFixed(2)} a day); ` +
      `all packets by reason ${JSON.stringify(Object.fromEntries([...reasons].sort()))}`,
  );
}
process.exit(0);
