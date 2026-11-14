/**
 * Test support (D1850): the gate never redacts less than main did before D1850 (`secrets.baseline.ts`, frozen). The
 * reference oracle (`secrets.reference.ts`) moves with every detection change, so it cannot see a change that loses
 * a secret; this can. Two checks a text:
 *
 * - every character inside a span some baseline rule finds is inside a span some rule of the gate finds;
 * - every character the baseline's `sanitizeForStore` removes, the gate's removes too (`lessThanBaseline`).
 *
 * Also a command, for the fuzz at scale:
 *
 *   bun packages/redact/src/never-less.ts 250000 101       # texts, seed: fuzz and keyword-chain texts alternating
 */
import { prng } from "./differential.ts";
import { chainText, gateText } from "./gate-differential.ts";
import {
  assignmentSpans as assignmentSpansBefore,
  REDACTED,
  structuralMask as structuralMaskBefore,
} from "./redact.baseline.ts";
import { type Gate, gateOf, secretRules } from "./secrets.ts";
import { gateOf as gateOfBaseline, secretRules as secretRulesBaseline } from "./secrets.baseline.ts";

let gates: { now: Gate; baseline: Gate; post: Set<string> } | undefined;

/** Per character of `text`, 1 when a span the gate's rules find covers it. */
function spanMask(gate: Gate, text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const found of gate.findings(text)) for (const [start, end] of found.spans) mask.fill(1, start, end);
  return mask;
}

/**
 * What the baseline's `sanitizeForStore` removes from `text`, exactly: its rules' spans (and the assignment pass's,
 * with any finding), then what its structural pass removes from the gated text (`structuralMask`), traced back.
 */
function baselineMask(text: string): Uint8Array {
  const found = gates!.baseline.findings(text).flatMap((f) => f.spans);
  const spans = (found.length > 0 ? [...found, ...assignmentSpansBefore(text)] : found).sort((a, b) => a[0] - b[0]);
  const mask = new Uint8Array(text.length);
  const map: number[] = [];
  let gated = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const kept = Math.max(start, at);
    gated += text.slice(at, kept) + (start >= at ? REDACTED : "");
    for (let i = at; i < kept; i++) map.push(i);
    if (start >= at) for (let i = 0; i < REDACTED.length; i++) map.push(-1);
    mask.fill(1, kept, end);
    at = end;
  }
  gated += text.slice(at);
  for (let i = at; i < text.length; i++) map.push(i);
  const structural = structuralMaskBefore(gated, 15);
  for (let j = 0; j < gated.length; j++) if (structural[j] === 1 && map[j]! >= 0) mask[map[j]!] = 1;
  return mask;
}

/** `text` with each maximal run `mask` marks replaced by one sentinel. */
function render(text: string, mask: Uint8Array): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length;) {
    if (mask[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && mask[j] === 1) j++;
    out += text.slice(from, i) + REDACTED;
    from = i = j;
  }
  return out + text.slice(from);
}

/** Adjacent sentinels as one: the pipeline can leave two side by side where a mask has one run. */
const merged = (s: string) => s.replace(/(?:\[REDACTED\]){2,}/g, REDACTED);

/**
 * Where the gate redacts less than the baseline on `text`, or undefined when it does not. The spans of every rule
 * the baseline has must be inside the gate's; and the gate must store either what the baseline stores, or that
 * text with D1850's rules' spans also taken out (the baseline's mask, checked against the baseline's own output, plus
 * those spans): so every character the baseline removes, the gate removes.
 */
export function lessThanBaseline(text: string): string | undefined {
  if (!gates) {
    const rules = secretRules();
    gates = {
      now: gateOf(rules),
      baseline: gateOfBaseline(secretRulesBaseline()),
      post: new Set(rules.filter((rule) => rule.post).map((rule) => rule.id)),
    };
  }
  const mine = spanMask(gates.now, text);
  const theirs = spanMask(gates.baseline, text);
  for (let i = 0; i < text.length; i++) {
    if (theirs[i] === 1 && mine[i] === 0) return `span: character ${i} (${JSON.stringify(text.slice(i, i + 20))})`;
  }
  const before = gates.baseline.sanitizeForStore(text);
  const now = gates.now.sanitizeForStore(text);
  if (now === before) return undefined;
  const mask = baselineMask(text);
  // The mask is the baseline's output (a text that holds a sentinel of its own can read either way: left out).
  if (!text.includes(REDACTED) && merged(render(text, mask)) !== merged(before)) {
    return `baseline mask: ${JSON.stringify(render(text, mask))} vs ${JSON.stringify(before)}`;
  }
  const post = gates.now.findings(text).filter((f) => gates!.post.has(f.id));
  for (const f of post) for (const [start, end] of f.spans) mask.fill(1, start, end);
  if (post.length > 0) for (const [start, end] of assignmentSpansBefore(text)) mask.fill(1, start, end);
  const expected = render(text, mask);
  return now === expected ? undefined : `stored: ${JSON.stringify(now)} vs ${JSON.stringify(expected)}`;
}

/** Where the baseline mask (`structuralMask` traced back) is not what the baseline stores, or undefined. */
export function baselineMaskDiffers(text: string): string | undefined {
  lessThanBaseline("");
  if (text.includes(REDACTED)) return undefined;
  const rendered = merged(render(text, baselineMask(text)));
  const stored = merged(gates!.baseline.sanitizeForStore(text));
  return rendered === stored ? undefined : `${JSON.stringify(rendered)} vs ${JSON.stringify(stored)}`;
}

/** `count` texts from `seed`, fuzz and chain texts alternating: the texts where the gate redacts less. */
export function fuzzNeverLess(
  count: number,
  seed: number,
): { texts: number; failures: { text: string; why: string }[] } {
  const rnd = prng(seed);
  const failures: { text: string; why: string }[] = [];
  for (let i = 0; i < count; i++) {
    const text = i % 2 === 0 ? gateText(rnd) : chainText(rnd);
    const why = lessThanBaseline(text);
    if (why) failures.push({ text, why });
  }
  return { texts: count, failures };
}

if (import.meta.main) {
  const t0 = performance.now();
  const result = fuzzNeverLess(Number(process.argv[2] ?? 100_000), Number(process.argv[3] ?? 1));
  const seconds = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ texts: result.texts, failures: result.failures.slice(0, 5), seconds }));
}
