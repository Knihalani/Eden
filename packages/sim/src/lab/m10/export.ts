#!/usr/bin/env bun
/**
 * M10 (lab only): the card tagger's item-level set. Every item a sync of the train and longtail worlds holds
 * (hidden, control and neutral variants, seeds 41-44, built as `cold-start.ts` builds them), joined by `cardKey` with
 * the card the shipped enricher recorded on Haiku (`cards-shipped.jsonl.gz`). heldout19 is never built: its lines in
 * the file match no item here and are never read out.
 *
 *   bun packages/sim/src/lab/m10/export.ts --out .local/m10/items.jsonl [--suites train,longtail] [--seeds 41,42,43,44]
 *
 * Row: `{h, suite, seed, planted, title, own, dated, source, strict, worth, card}`; `own` is `ownText` (what the card
 * prompt reads), `card` the recorded card or null where none was recorded.
 */
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { ItemCache } from "@eden/engine";
import { readText } from "./reader";
import { cardKey, datedOf, ownText, worthCarding, worthCardingStrict, type Card } from "../../../../engine/src/cards";
import { REALISTIC, simSources } from "../../sources";
import { worldOf } from "../ab-common";
import { SHIPPED_PATH } from "../cards-disk";
import { parseSuites, prepareWorld } from "../suites";
import { buildWorld } from "../../world";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const OUT = opt("out", ".local/m10/items.jsonl");
const suites = parseSuites(opt("suites", "train,longtail"));
if (suites.some((s) => /heldout/.test(s))) throw new Error("held-out suites are never exported");
const seeds = opt("seeds", "41,42,43,44").split(",").map(Number);

const shipped = new Map<string, Card | null>();
for (const line of gunzipSync(readFileSync(SHIPPED_PATH)).toString("utf8").split("\n")) {
  if (!line.trim()) continue;
  const l = JSON.parse(line) as { h: string; c?: Card | null };
  if (l.c !== undefined) shipped.set(l.h, l.c);
}

const rows = new Map<string, Record<string, unknown>>();
for (const suite of suites) {
  for (const variant of ["hidden", "control", "neutral"] as const) {
    for (const seed of seeds) {
      let built;
      try {
        built = worldOf(seed, suite, variant, { maxTasks: 30, maxOffworld: 5 });
      } catch {
        continue;
      }
      const { world } = built;
      // Planted: what the suite added past its prepared base world (the same seed, `prepareWorld` alone).
      const base = buildWorld({ seed: seed * 1_000 });
      prepareWorld(suite, base, seed);
      const baseIds = new Set(base.items.map((i) => i.id));
      const plantedIds = new Set(world.items.filter((i) => !baseIds.has(i.id)).map((i) => i.id));
      const cache = new ItemCache({ maxItemsPerUser: 100_000 });
      const raw = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
      for (const it of cache.put({ tenantId: "t", userId: "u" }, raw, 0)) {
        const h = cardKey(it);
        if (rows.has(h)) continue;
        const dated = datedOf(it);
        const anchor = Date.parse(`${dated || new Date(world.now).toISOString().slice(0, 10)}T12:00:00Z`);
        const read = readText(it.title, ownText(it), anchor);
        rows.set(h, {
          h,
          suite,
          seed,
          variant,
          planted: plantedIds.has(it.id),
          id: it.id,
          title: it.title.slice(0, 200),
          own: ownText(it),
          text: it.text.slice(0, 2700),
          updatedAt: it.updatedAt ?? null,
          meta: it.meta ?? null,
          dated: datedOf(it),
          now: new Date(world.now).toISOString().slice(0, 10),
          source: it.sourceId,
          start: it.meta?.start ?? null,
          strict: worthCardingStrict(it),
          worth: worthCarding(it),
          toks: read.toks.map((t) => [t.w, t.s]),
          dates: read.dates,
          amounts: read.amounts,
          card: shipped.has(h) ? shipped.get(h) : undefined,
        });
      }
    }
  }
}
const list = [...rows.values()];
writeFileSync(OUT, list.map((r) => JSON.stringify(r)).join("\n") + "\n");
const withCard = list.filter((r) => r.card !== undefined);
console.error(
  JSON.stringify({
    items: list.length,
    withCard: withCard.length,
    strict: list.filter((r) => r.strict).length,
    strictWithCard: withCard.filter((r) => r.strict).length,
    constraint: withCard.filter((r) => r.card && (r.card as Card).kind !== "none").length,
  }),
);
