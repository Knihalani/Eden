/**
 * Wave 8.1 live A/B protocol. Paired. `expect` is registered before any run.
 *
 * There is no live Claude Code invoice in the tree. Missing EDEN_LIVE_INVOICE
 * (or analogue TURN_CENTS / ISLAND_CENTS) retires the live-S1b cell — never a
 * synthetic Claude bill.
 *
 *   bun run benchmarks/campaign/live-ab.ts
 *   bun test benchmarks/campaign/live-ab.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveInvoiceStatus, parseInvoice, type InvoiceCell } from "@eden/measure";

/** Pre-registered before invoice parse or any cell. */
export const LIVE_AB_EXPECT =
  "live-S1b cell is live-invoice or retired; replica host-drop is a permanent host limit; " +
  "oblivious-long stays a limit not a win";

export const LIVE_AB_PROTOCOL = {
  name: "live-s1b",
  question: "Is S1b billed from a live Claude Code invoice, or is that quote retired?",
  expect: LIVE_AB_EXPECT,
  paired: true as const,
  arms: ["control", "treatment"] as const,
};

export const LIVE_AB_MD = join(import.meta.dir, "LIVE-AB.md");
export const HOST_DROP_MD = join(import.meta.dir, "HOST-DROP.md");

export function readLiveInvoice(path = process.env.EDEN_LIVE_INVOICE): InvoiceCell {
  if (!path || !String(path).trim()) return parseInvoice(null);
  try {
    if (!existsSync(path)) return parseInvoice(null);
    return parseInvoice(readFileSync(path, "utf8"));
  } catch {
    return parseInvoice(null);
  }
}

export function liveS1bCell(cell: InvoiceCell = readLiveInvoice()): {
  source: InvoiceCell["source"];
  status: "measured" | "retired";
  cents: number | null;
  note: string;
} {
  return {
    source: cell.source,
    status: liveInvoiceStatus(cell),
    cents: cell.cents,
    note: cell.note,
  };
}

export function writeLiveAbMd(cell: InvoiceCell = readLiveInvoice(), path = LIVE_AB_MD): string {
  const s1b = liveS1bCell(cell);
  const retired = s1b.status === "retired";
  const body = `# Live A/B study (Wave 8.1)

Pre-registered ${new Date().toISOString().slice(0, 10)} via \`bun run benchmarks/campaign/live-ab.ts\`.
Paired protocol. Expect field recorded **before** any invoice parse or cell.

## Protocol

| Field | Value |
|---|---|
| name | \`${LIVE_AB_PROTOCOL.name}\` |
| question | ${LIVE_AB_PROTOCOL.question} |
| expect | ${LIVE_AB_PROTOCOL.expect} |
| paired | control vs treatment |
| arms | ${LIVE_AB_PROTOCOL.arms.join(" / ")} |

Materiality for negative-control parity is unchanged: ±1%. Simulator turns are arithmetic. \
Wall-clock is the sampled meter.

## Retired vs measured

| Cell | Status | Source | Note |
|---|---|---|---|
| live-S1b invoice | **${retired ? "retired" : "measured"}** | ${s1b.source} | ${s1b.note} |
| analogue S1b −9.1% cents | measured (analogue) | analogue-headless | \
\`benchmarks/campaign/SILENT-DROP.md\`. The analogue −9.1% cell is not a live Claude Code invoice. |
| replica host-drop | host limit | replica-only | \`benchmarks/campaign/HOST-DROP.md\`. \
Live Claude Code cannot ack always-drop of a correct rewrite. |
| oblivious-long | limit | campaign wrap | +2.8% cents / +3.2% wall. Retired from the win table. |

No live Claude Code invoice file is in the tree. The analogue −9.1% cell is not a live bill. This \
quote is retired until an invoice parses as live-invoice.

Wave 19 pin: landing, \`/proof\`, whitepaper, and digest still have no live Claude Code invoice \
claim. The billed S1b cell stays retired. Analogue −9.1% stays labeled analogue.

## Methodology

Every public number below cites a campaign file. UNCERTIFIED is never a win. Analogue cents and \
replica host-drop cannot be quoted as live Claude Code facts.

Paired, counterbalanced, A/A-checked campaign cells live in \
\`benchmarks/campaign/bench-campaign.ts\` and \`bench-negative.ts\`. Decision rule: \
\`@eden/measure\` \`decide()\`.

## Win table (campaign — not live invoices)

| Scenario | Printed | File |
|---|---|---|
| short-support | 6.67× turns | \`bench-campaign.ts\` |
| long-desk | 1.36× turns | \`bench-campaign.ts\` |
| long-orders | 1.19× turns | \`bench-campaign.ts\` |
| long-etl | 1.43× turns | \`bench-campaign.ts\` |
| long-incident | 1.35× turns | \`bench-campaign.ts\` |
| thrash-enforce | 5.14× spend | \`bench-campaign.ts\` |
| fastdesk-live | 7.0× turns | \`bench-negative.ts\` |

## Analogue (replica — not a campaign WIN)

| Scenario | Printed | File |
|---|---|---|
| S1b headless analogue | −9.1% cents (analogue) | \`SILENT-DROP.md\` |

## Parity table

| Regime | Printed | File |
|---|---|---|
| unique-work | parity +0.2% wall | \`bench-negative.ts\` |
| creative | parity (refuses) | \`bench-negative.ts\` |
| micro | exact parity | \`bench-negative.ts\` |
| chaos-observe | parity | \`bench-negative.ts\` |

## Limits (not wins)

| Item | Printed | File |
|---|---|---|
| oblivious-long | +2.8% cents / +3.2% wall | \`benchmarks/campaign/OBLIVIOUS-LONG.md\` |
| ood-long | parity (miss) | \`bench-campaign.ts\` |
| certification bounds | 11/14 soak certified | \`benchmarks/campaign/WITNESS-ECON.md\` |
| replica host-drop | host limit (replica-only) | \`HOST-DROP.md\` |
| S1b live Claude Code invoice | retired | this file |

oblivious-long is a limit / loss, retired from the win table. Wrap skipRest when the model never \
early-stops bills island spend with no turn savings.

## Invoice parse

\`EDEN_LIVE_INVOICE\` path → \`parseInvoice\`. Missing file or analogue TURN_CENTS / ISLAND_CENTS → \
retired. Status this run: **${s1b.status}** (${s1b.source}).
`;
  writeFileSync(path, body);
  return body;
}

export function writeHostDropMd(path = HOST_DROP_MD): string {
  const body = `# Host-drop limit (Wave 8.1 leftover 2)

Live Claude Code cannot ack an always-drop of a correct native rewrite.

Replica host-drop is a permanent **host limit**, not a live Claude Code ack. The silent-drop \
replica always drops \`updatedToolOutput\` even when the rewrite is shape-correct; that cell is \
analogue / replica-only (\`SILENT-DROP.md\`, \`silent-drop.ts\`).

Receipt class \`host-drop\` stays. The ledger still writes \`host-drop\` when a host (or replica) \
actually drops the rewrite so Home/canvas/digest can name Degraded. Replica host-drop cannot be \
quoted as a live Claude Code ack (replica-only host limit).

Pre-registered expect: ${LIVE_AB_EXPECT}
`;
  writeFileSync(path, body);
  return body;
}

async function main(): Promise<void> {
  console.log(`live-ab — ${LIVE_AB_PROTOCOL.name}`);
  console.log(`  expect: ${LIVE_AB_PROTOCOL.expect}`);
  const cell = readLiveInvoice();
  const s1b = liveS1bCell(cell);
  console.log(`  live-S1b ${s1b.status} (${s1b.source})`);
  writeLiveAbMd(cell);
  writeHostDropMd();
  console.log("  wrote benchmarks/campaign/LIVE-AB.md");
  console.log("  wrote benchmarks/campaign/HOST-DROP.md");
}

if (import.meta.main) await main();
