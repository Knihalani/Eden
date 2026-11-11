/**
 * A length-debiased M2 (M14, D1024). LAB ONLY. M2's facts are longer than their twins in 94% of tasks, so length
 * alone separates them (D1022). Filtering to a 50/50 balance would keep about one task in eight; instead every item
 * gets role-neutral boilerplate of its own source (a signature, disclaimer, footer, chat filler, app footer):
 *
 * - every item of the world (fact, twin, neutrals, background) gets one chunk at the same base rate, so the presence
 *   of boilerplate says nothing about the role;
 * - a coin per task picks fact or twin; it gets as many chunks as the originally shorter of the two needs to overtake
 *   the other (by a random margin), so the coin's item ends longer whichever role it has, and the amount of padding
 *   is the same in distribution for facts and twins.
 *
 * Each item's added characters go in `meta.pad`; `logo.py run --model padcue` measures what cue the padding leaves.
 * Labels are unchanged: the chunks carry no constraint and name no one in the task.
 *
 *   bun packages/sim/src/lab/m14/debias.ts IN.jsonl --out OUT.jsonl
 */
import { writeFileSync } from "node:fs";
import { Rng } from "../../rng";
import type { SynthItem, SynthWorld } from "../synth/schema";
import { readWorlds } from "../synth/suite";

const MAIL = [
  "Kind regards,\nThe Customer Team",
  "This email and any attachments are confidential and intended solely for the addressee. If you have received it in error, please notify the sender and delete it.",
  "Sent from my phone",
  "Please consider the environment before printing this email.",
  "You are receiving this message because you have an account with us. Manage your preferences in your account settings.",
  "--\nOffice hours Monday to Friday, 9am to 5pm. We aim to reply within two working days.",
  "Thanks again, and have a lovely week.",
];
const CHAT = ["ok", "👍", "lol", "thx", "see you later", "brb", "nice one", "haha yes", "cool cool", "on my way"];
const DOC = [
  "Page 1 of 1",
  "This document is for information only and does not form part of any contract.",
  "Last reviewed: see revision history.",
  "Internal use only. Please do not forward outside the household.",
  "Contents: 1. Summary 2. Details 3. Contacts",
  "Questions? See the shared FAQ in the same folder.",
];
const APP = [
  "Manage notifications in the app settings.",
  "This is an automated message. Please do not reply.",
  "Download the app for faster access.",
  "Need help? Visit the help centre.",
  "Ref: AUTO-NOTICE",
];

const chunkFor = (it: SynthItem, rng: Rng) => {
  if (it.kind === "chat")
    return Array.from({ length: rng.int(1, 3) }, () => `${rng.pick(["Sam", "Alex", "Jo"])}: ${rng.pick(CHAT)}`).join(
      "\n",
    );
  if (["mail", "newsletter", "promo"].includes(it.kind)) return rng.pick(MAIL);
  if (it.kind === "notification") return rng.pick(APP);
  return rng.pick(DOC);
};

function pad(it: SynthItem, rng: Rng): void {
  const c = chunkFor(it, rng);
  it.text = `${it.text}\n\n${c}`.slice(0, 4_000);
  it.meta = { ...(it.meta ?? {}), pad: String(Number(it.meta?.pad ?? 0) + c.length + 2) };
}

export function debias(w: SynthWorld, seed: number): SynthWorld {
  const out: SynthWorld = structuredClone(w);
  const rng = new Rng(seed);
  for (const it of out.items) if (rng.chance(0.6)) pad(it, rng);
  const items = new Map(out.items.map((i) => [i.id, i]));
  const len = (i: SynthItem) => i.title.length + i.text.length;
  for (const t of out.tasks) {
    const fact = items.get(t.fact)!;
    const decoy = items.get(t.decoy)!;
    // n = the chunks the originally shorter item needs to overtake the other. The coin's item gets n chunks either
    // way, so how much padding an item carries says nothing about its role (a first version padded only the item that
    // had to grow, which left a boilerplate-amount cue at 0.690).
    const [orig_long, orig_short] = len(fact) >= len(decoy) ? [fact, decoy] : [decoy, fact];
    const margin = 1 + rng.next() * 0.2;
    const probe = structuredClone(orig_short);
    let n = 0;
    while (n < 40 && len(probe) <= len(orig_long) * margin && probe.text.length < 3_900) {
      pad(probe, rng);
      n++;
    }
    const long = rng.chance(0.5) ? fact : decoy;
    const short = long === fact ? decoy : fact;
    for (let k = 0; k < n; k++) pad(long, rng);
    for (let k = 0; k < 40 && len(long) <= len(short) && long.text.length < 3_900; k++) pad(long, rng);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const o = argv.indexOf("--out");
  const worlds = readWorlds(argv[0]!).map((w, i) => debias(w, 101 + i));
  writeFileSync(argv[o + 1]!, worlds.map((w) => JSON.stringify(w) + "\n").join(""));
  let longer = 0;
  let n = 0;
  for (const w of worlds) {
    const items = new Map(w.items.map((i) => [i.id, i]));
    for (const t of w.tasks) {
      const f = items.get(t.fact)!;
      const d = items.get(t.decoy)!;
      n++;
      if (f.title.length + f.text.length > d.title.length + d.text.length) longer++;
    }
  }
  console.log(`${worlds.length} worlds, fact longer in ${longer} of ${n} tasks → ${argv[o + 1]}`);
}
