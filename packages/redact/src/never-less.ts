/**
 * Test support (D1850): the gate never redacts less than main did before D1850 (`secrets.baseline.ts`, frozen). The
 * reference oracle (`secrets.reference.ts`) moves with every detection change, so it cannot see a change that loses
 * a secret; this can. Two checks a text:
 *
 * - every character inside a span some baseline rule finds is inside a span some rule of the gate finds;
 * - every character the baseline's `sanitizeForStore` removes, the gate's removes too (`lessThanBaseline`);
 *
 * except the characters of a value that is code or a placeholder (`not-secret.ts`), which D1850 leaves on purpose
 * (and only those: `compose.ts` reports which, and each is checked here).
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
import { notSecret, placeholderToken } from "./not-secret.ts";
import { type Gate, gateOf, secretRules } from "./secrets.ts";
import {
  type Gate as BaselineGate,
  gateOf as gateOfBaseline,
  secretRules as secretRulesBaseline,
} from "./secrets.baseline.ts";

let gates: { now: Gate; baseline: BaselineGate } | undefined;

function setUp(): { now: Gate; baseline: BaselineGate } {
  gates ??= { now: gateOf(secretRules()), baseline: gateOfBaseline(secretRulesBaseline()) };
  return gates;
}

/**
 * What the baseline's `sanitizeForStore` removes from `text`, worked out apart from it with its own frozen modules:
 * its rules' spans (and the assignment pass's, with any finding), then what its structural pass removes from the
 * gated text (`structuralMask`), traced back. Checked against its output (`baselineMaskDiffers`).
 */
function baselineMask(text: string): Uint8Array {
  const found = setUp()
    .baseline.findings(text)
    .flatMap((f) => f.spans);
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

/** Where the baseline mask is not what the baseline stores on `text` (sentinels side by side as one), or undefined. */
export function baselineMaskDiffers(text: string): string | undefined {
  if (text.includes(REDACTED)) return undefined; // a sentinel of the text's own reads either way
  const rendered = merged(render(text, baselineMask(text)));
  const stored = merged(setUp().baseline.sanitizeForStore(text));
  return rendered === stored ? undefined : `${JSON.stringify(rendered)} vs ${JSON.stringify(stored)}`;
}

/**
 * Where the gate redacts less than the baseline on `text`, or undefined when it does not. Four checks:
 *
 * - every character in a span of a baseline rule is in a span of the gate's rules, or in one they excused;
 * - the gate's own account of main's pipeline (`explain().before`) is the frozen baseline's mask, character for
 *   character (so the gate starts from what main removed), and that mask is what the baseline stores;
 * - the gate stores what its mask (`after`) says;
 * - every character main removed and the gate keeps was removed only through an excused value, and every excused
 *   value is code or a placeholder by `not-secret.ts`'s own tests.
 */
export function lessThanBaseline(text: string): string | undefined {
  const { now, baseline } = setUp();
  const explained = now.explain(text);
  const mine = new Uint8Array(text.length);
  for (const f of now.findings(text)) for (const [start, end] of f.spans) mine.fill(1, start, end);
  for (const [start, end] of explained.excusedSpans) mine.fill(1, start, end);
  for (const f of baseline.findings(text)) {
    for (const [start, end] of f.spans) {
      for (let i = start; i < end; i++) {
        if (mine[i] === 0) return `span: ${f.id} at ${i} (${JSON.stringify(text.slice(i, i + 24))})`;
      }
    }
  }
  const before = baselineMask(text);
  const differs = baselineMaskDiffers(text);
  if (differs) return `baseline mask: ${differs}`;
  for (let i = 0; i < text.length; i++) {
    if (before[i] !== explained.before![i]) return `main's pipeline at ${i}: ${JSON.stringify(text.slice(i, i + 24))}`;
  }
  const stored = now.sanitizeForStore(text);
  if (!text.includes(REDACTED) && merged(stored) !== merged(render(text, explained.after!))) {
    return `stored: ${JSON.stringify(stored)} vs its mask ${JSON.stringify(render(text, explained.after!))}`;
  }
  for (const value of explained.values!) {
    if (!(notSecret(value) || placeholderToken(value)))
      return `excused a value that is not code: ${JSON.stringify(value)}`;
  }
  for (let i = 0; i < text.length; i++) {
    if (before[i] === 1 && explained.after![i] === 0 && explained.excused![i] === 0) {
      return `stored less at ${i}: ${JSON.stringify(text.slice(i, i + 24))}`;
    }
  }
  return undefined;
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
