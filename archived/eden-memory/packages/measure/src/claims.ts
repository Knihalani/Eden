/**
 * Frozen public claims (Wave 21 honesty files). Proof page, case studies, and
 * publish-check read this table. A number that is not here must not be printed
 * as a fact. Every `file` is a measurement close a reader can open — not the
 * roadmap.
 *
 * `source` is the honesty tag:
 *   campaign        — paired campaign / wrap path (not a Claude Code invoice)
 *   analogue-headless — TURN_CENTS / ISLAND_CENTS replica
 *   live-invoice    — billed from a provider invoice file
 *   host-limit      — live host cannot ack; replica-only
 *   retired         — claim withdrawn in public
 */
export type ClaimSource = "campaign" | "analogue-headless" | "live-invoice" | "host-limit" | "retired";
export type ClaimKind = "win" | "parity" | "analogue" | "limit" | "retired";

export type PublicClaim = {
  id: string;
  kind: ClaimKind;
  name: string;
  statement: string;
  printed: string;
  file: string;
  source: ClaimSource;
  /** Campaign fixture vertical. Never a customer name. */
  vertical?: string;
  /** Customer case studies only. Fixture rows omit this. */
  approved?: boolean;
};

export const PUBLIC_CLAIMS: PublicClaim[] = [
  {
    id: "short-support",
    kind: "win",
    name: "short-support",
    statement: "Live program, one stretch: 6.67× fewer turns, 1.78× faster, 4.17× cheaper (p=0.0005, n=12).",
    printed: "6.67× turns",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
    vertical: "support",
  },
  {
    id: "long-desk",
    kind: "win",
    name: "long-desk",
    statement: "Desk lifecycle: 1.36× turns, 1.16× wall, 1.31× cheaper (p=0.016).",
    printed: "1.36× turns",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
    vertical: "desk",
  },
  {
    id: "long-orders",
    kind: "win",
    name: "long-orders",
    statement: "Fan-out loop + refund: 1.19× turns, 1.12× wall, 1.19× cheaper (p=0.016).",
    printed: "1.19× turns",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
    vertical: "orders",
  },
  {
    id: "long-etl",
    kind: "win",
    name: "long-etl",
    statement: "Read fan-out then report: 1.43× turns, 1.28× wall, 1.36× cheaper (p=0.016).",
    printed: "1.43× turns",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
    vertical: "etl",
  },
  {
    id: "long-incident",
    kind: "win",
    name: "long-incident",
    statement: "Flaky reads and retries: 1.35× turns, 1.13× wall, 1.32× cheaper (p=0.016).",
    printed: "1.35× turns",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
    vertical: "incident",
  },
  {
    id: "thrash-enforce",
    kind: "win",
    name: "thrash-enforce",
    statement: "Runaway loop halted: 5.14× less spend, 5.29× faster (p=0.002, n=10).",
    printed: "5.14× spend",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
  },
  {
    id: "fastdesk-live",
    kind: "win",
    name: "fastdesk-live",
    statement: "Instant tools, program live: 7.0× turns / 6.4× wall — think-time, not tool time.",
    printed: "7.0× turns",
    file: "benchmarks/campaign/bench-negative.ts",
    source: "campaign",
    vertical: "desk",
  },
  {
    id: "unique-work",
    kind: "parity",
    name: "unique-work",
    statement: "Nothing repeats: parity (+0.2% wall = recorded overhead).",
    printed: "parity +0.2% wall",
    file: "benchmarks/campaign/bench-negative.ts",
    source: "campaign",
  },
  {
    id: "creative",
    kind: "parity",
    name: "creative",
    statement: "All-judgment stretches: compile refuses honestly; parity.",
    printed: "parity (refuses)",
    file: "benchmarks/campaign/bench-negative.ts",
    source: "campaign",
  },
  {
    id: "micro",
    kind: "parity",
    name: "micro",
    statement: "Sub-minimum 2-call stretches ×16: exact parity.",
    printed: "exact parity",
    file: "benchmarks/campaign/bench-negative.ts",
    source: "campaign",
  },
  {
    id: "chaos-observe",
    kind: "parity",
    name: "chaos-observe",
    statement: "67% failures, observe mode: parity — a broken Eden does not halt the agent.",
    printed: "parity",
    file: "benchmarks/campaign/bench-negative.ts",
    source: "campaign",
  },
  {
    id: "s1b-analogue",
    kind: "analogue",
    name: "S1b headless analogue",
    statement:
      "Hook-path remainder deny on a headless replica that always drops updatedToolOutput: −9.1% cents vs raw (3.3 → 3.0, n=8). Analogue TURN_CENTS, not a live Claude Code invoice.",
    printed: "−9.1% cents (analogue)",
    file: "benchmarks/campaign/SILENT-DROP.md",
    source: "analogue-headless",
  },
  {
    id: "oblivious-long",
    kind: "limit",
    name: "oblivious-long",
    statement:
      "Wrap skipRest when the model never early-stops: +2.8% cents and +3.2% wall. Retired from the win table. Island spend with no turn savings.",
    printed: "+2.8% cents / +3.2% wall",
    file: "benchmarks/campaign/OBLIVIOUS-LONG.md",
    source: "campaign",
  },
  {
    id: "ood-long",
    kind: "limit",
    name: "ood-long",
    statement: "Every goal out of envelope against a live program: steering misses; parity expected; corruption fails.",
    printed: "parity (miss)",
    file: "benchmarks/campaign/bench-campaign.ts",
    source: "campaign",
  },
  {
    id: "cert-bounds",
    kind: "limit",
    name: "certification bounds",
    statement:
      "Soak go-live 11/14 rounds. The 3 misses are witness-efficiency, not quoted as certified savings. UNCERTIFIED is never a win.",
    printed: "11/14 soak certified",
    file: "benchmarks/campaign/WITNESS-ECON.md",
    source: "campaign",
  },
  {
    id: "s1b-live-invoice",
    kind: "retired",
    name: "S1b live Claude Code invoice",
    statement:
      "No live Claude Code invoice file is in the tree. The analogue −9.1% cell is not a live bill. This quote is retired until an invoice parses as live-invoice.",
    printed: "retired",
    file: "benchmarks/campaign/LIVE-AB.md",
    source: "retired",
  },
  {
    id: "replica-host-drop",
    kind: "limit",
    name: "replica host-drop",
    statement:
      "Live Claude Code does not ack an always-drop of a correct native rewrite. Replica host-drop is a permanent host limit, not a live ack.",
    printed: "host limit (replica-only)",
    file: "benchmarks/campaign/HOST-DROP.md",
    source: "host-limit",
  },
  {
    id: "jit-soak",
    kind: "win",
    name: "JIT soak default",
    statement:
      "Wave 22.2 bun run bench:jit-soak printed PASS precision=1.000 n=38 (gh 18/18, kubectl 12/12, name-only 4/4, campaign 4/4). Hold-outs jit-id / jit-cli / jit-url each printed PASS precision=1.000. Unique-work empty-catalog held. Default EDEN_SURFACE is jit. EDEN_SURFACE=all is the opt-out.",
    printed: "PASS precision=1.000 n=38",
    file: "benchmarks/campaign/JIT-SOAK.md",
    source: "campaign",
  },
];

export function claimsOf(kind: ClaimKind): PublicClaim[] {
  return PUBLIC_CLAIMS.filter((c) => c.kind === kind);
}

export function fixtureStudies(): PublicClaim[] {
  const seen = new Set<string>();
  const out: PublicClaim[] = [];
  for (const c of PUBLIC_CLAIMS) {
    if (!c.vertical || c.kind !== "win" || c.source !== "campaign") continue;
    if (seen.has(c.vertical)) continue;
    seen.add(c.vertical);
    out.push(c);
  }
  return out;
}

export function customerStudies(): PublicClaim[] {
  return PUBLIC_CLAIMS.filter((c) => c.approved === true);
}

export function claimById(id: string): PublicClaim | undefined {
  return PUBLIC_CLAIMS.find((c) => c.id === id);
}
