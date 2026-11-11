/**
 * M13 (addendum C): the short throwaway turns the review found the round-3 gate starting a push on, read by a gate
 * file with the shipped rule's reading. Reported only: round 4's training data holds turns like these.
 *
 *   bun packages/sim/lab/m13/probe.ts GATE.bin
 */
import { readFileSync } from "node:fs";
import { pushStart, TurnGate } from "@eden/engine";

const gate = new TurnGate(new Uint8Array(readFileSync(process.argv[2]!)));
const T = [
  "hello",
  "hello there",
  "hi there",
  "hey there",
  "hi",
  "hey",
  "good morning",
  "morning!",
  "hello!",
  "hi Eden",
  "hey, how's it going",
  "bonjour",
  "hallo zusammen",
  "hola",
  "ciao a tutti",
  "ok",
  "lol",
  "test",
  "testing 123",
  "hmm",
  "x",
  "asdf",
  "?",
];
let n = 0;
for (const t of T) {
  const s = pushStart(t, { open: true, indirect: true });
  const v = gate.read(t, { how: s?.how ?? "none", rest: s !== null && s.request !== t });
  if (v.needs) n++;
  console.log(
    `${v.needs ? "START" : "-    "} ${v.kind.padEnd(9)} ${v.logit.toFixed(1).padStart(6)} ${JSON.stringify(t)}`,
  );
}
console.log(`${n} of ${T.length} start a push`);
