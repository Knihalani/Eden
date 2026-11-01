#!/usr/bin/env bun
/**
 * What the secret gate lets through in the sim worlds (docs/research/edge-secret.md): every item of the base world
 * and of the development and old in-sample suites (both variants, each seed), title and text through the gate, then
 * looser detectors than the gate's own over the result: prefixed tokens, AWS key ids, JWTs, PEM banners, `key: value`
 * assignments, URL userinfo, and 20+ character high-entropy tokens. Each item's planted `secret` must be gone. With
 * `--without <rule>`, also counts the items whose stored text that rule changes. No model call.
 *
 *   bun packages/sim/src/lab/secret-scan.ts [--seeds 41,42,43] [--without eden-aws-secret]
 *
 * The plant functions are imported one by one rather than through `suites.ts`, so no blind suite is loaded.
 */
import { gateOf, secretRules } from "@eden/redact";
import { buildWorld, type World } from "../world";
import { plantHidden } from "./hidden-context";
import { plantDev6a } from "./hidden-dev6a";
import { plantDev6b } from "./hidden-dev6b";
import { plantHeldout } from "./hidden-heldout";
import { plantHeldout2 } from "./hidden-heldout2";
import { plantHeldout3 } from "./hidden-heldout3";
import { plantHeldout4 } from "./hidden-heldout4";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SEEDS = opt("seeds", "41,42,43").split(",").map(Number);
const WITHOUT = opt("without", "");

type Plant = (world: World, seed: number, variant: "hidden" | "control") => unknown;
const PLANTS: Record<string, Plant> = {
  base: () => [],
  hidden: plantHidden,
  heldout: plantHeldout,
  heldout2: plantHeldout2,
  heldout3: plantHeldout3,
  heldout4: plantHeldout4,
  dev6a: plantDev6a,
  dev6b: plantDev6b,
};

/** Looser than the gate on purpose: anything they find in stored text is worth a look. */
const SHAPES: [string, RegExp][] = [
  ["prefixed-token", /\b(?:[spr]k_(?:live|test)_\w+|gh[pousr]_\w+|xox[abprs]-[\w-]+|AIza[\w-]{20,}|ya29\.\S+)/g],
  ["aws-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["jwt", /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  [
    "assignment",
    /\b(?:password|passwd|pwd|pin|passcode|secret|token|api[_ -]?key|access[_ -]?key)\b\s*(?:is|=|:)\s*(?!\[REDACTED\])\S+/gi,
  ],
  ["url-userinfo", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/gi],
];
const LONG_TOKEN = /[A-Za-z0-9/+_=-]{20,}/g;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Sim links (`acme.com/p/onboarding-320`) are long tokens and no secret. */
const SIM_LINK = /\.com\/|\/p\//;

function shannon(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) entropy -= (count / text.length) * Math.log2(count / text.length);
  return entropy;
}

const rules = secretRules();
const gate = gateOf(rules);
const baseline = WITHOUT ? gateOf(rules.filter((rule) => rule.id !== WITHOUT)) : undefined;
const found = new Map<string, Map<string, number>>();
const note = (shape: string, sample: string) => {
  const samples = found.get(shape) ?? new Map<string, number>();
  samples.set(sample, (samples.get(sample) ?? 0) + 1);
  found.set(shape, samples);
};
const seen = new Set<string>();
const plantedLeaks: string[] = [];
const changed: string[] = [];
for (const [suite, plant] of Object.entries(PLANTS)) {
  for (const seed of SEEDS) {
    for (const variant of ["hidden", "control"] as const) {
      const world = buildWorld({ seed });
      plant(world, seed, variant);
      for (const item of world.items) {
        const raw = `${item.title}\n${item.text}`;
        // Every suite shares its seed's base world: count each distinct text once.
        if (seen.has(raw)) continue;
        seen.add(raw);
        const stored = gate.sanitizeForStore(raw);
        if (item.secret && stored.includes(item.secret)) plantedLeaks.push(`${suite}/${seed}: ${item.title}`);
        if (baseline && stored !== baseline.sanitizeForStore(raw)) changed.push(`${suite}/${seed}: ${item.title}`);
        for (const [shape, regex] of SHAPES) for (const match of stored.matchAll(regex)) note(shape, match[0]);
        for (const match of stored.matchAll(LONG_TOKEN)) {
          const token = match[0];
          if (/^[0-9a-f-]+$/i.test(token) || !/[A-Za-z]/.test(token) || !/\d/.test(token) || ULID.test(token)) continue;
          if (SIM_LINK.test(stored.slice(Math.max(0, match.index - 30), match.index + token.length))) continue;
          if (shannon(token) >= 3.5) note("high-entropy", token);
        }
      }
    }
  }
}

const shapes = Object.fromEntries(
  [...found].map(([shape, samples]) => [
    shape,
    {
      hits: [...samples.values()].reduce((sum, n) => sum + n, 0),
      samples: [...samples.keys()].slice(0, 10).map((s) => s.slice(0, 80)),
    },
  ]),
);
console.log(
  JSON.stringify(
    {
      seeds: SEEDS,
      items: seen.size,
      plantedLeaks,
      survivors: shapes,
      ...(WITHOUT ? { without: WITHOUT, changedByRule: changed.length, changed } : {}),
    },
    null,
    2,
  ),
);
