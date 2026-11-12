import { readFileSync, writeFileSync } from "node:fs";
import { checkMessages, leanSystem, CHECK_SYSTEM } from "../../../engine/src/push-check";
const rows = ["train", "reworded"]
  .flatMap((s) =>
    readFileSync(`.local/f7/base-${s}-43.dump.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
  )
  .filter((r) => r.yes !== null && r.reply);
// Deterministic stratified pick: hidden rows where the shipped check named the planted fact, control rows, neutral
// rows with a non-empty reply (where a stop could save something), 8 each, every k-th.
const pick = (xs: any[], n: number) => xs.filter((_, i) => i % Math.floor(xs.length / n) === 0).slice(0, n);
const sets = [
  ...pick(
    rows.filter((r) => r.variant === "hidden" && r.yes.includes(r.planted)),
    9,
  ),
  ...pick(
    rows.filter((r) => r.variant === "control"),
    8,
  ),
  ...pick(
    rows.filter((r) => r.variant === "neutral" && r.reply.length > 20),
    8,
  ),
];
const meta: any[] = [];
sets.forEach((r, k) => {
  const input = { request: r.request, today: r.today, items: r.items.map((it: any) => ({ ...it, hash: "" })) };
  for (const arm of ["W", "Y"]) {
    const m = checkMessages({ ...input, ...(arm === "Y" ? { lean: true } : {}) });
    writeFileSync(`.local/f7/pilot/${k}-${arm}.txt`, `SYSTEM:\n${m[0]!.content}\n\nUSER:\n${m[1]!.content}\n`);
  }
  meta.push({ k, variant: r.variant, planted: r.planted, ids: r.items.map((i: any) => i.id), recorded: r.yes });
});
writeFileSync(".local/f7/pilot/meta.json", JSON.stringify(meta));
console.log(sets.length, leanSystem(CHECK_SYSTEM).length);
