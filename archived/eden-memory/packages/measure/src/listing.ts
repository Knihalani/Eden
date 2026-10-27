/**
 * Unpublished skills-marketplace draft. Numbers come only from PUBLIC_CLAIMS.
 * Never POSTed. Never a customer list. Never a Determinism Index page.
 */
import { PUBLIC_CLAIMS, customerStudies, fixtureStudies, type ClaimKind, type PublicClaim } from "./claims";

/** First line of the withheld draft. Not a publish. */
export const CLAIMS_LISTING_BANNER = "Not published. Arc 8 numbers first.";

const KIND_ORDER: ClaimKind[] = ["win", "parity", "analogue", "limit", "retired"];

const KIND_HEAD: Record<ClaimKind, string> = {
  win: "Wins",
  parity: "Parity",
  analogue: "Analogue",
  limit: "Limits",
  retired: "Retired",
};

/** Multipliers (×) and percents in public copy. ASCII-normalized minus. */
export function listingNumberTokens(text: string): string[] {
  const norm = text.replace(/−/g, "-");
  const out: string[] = [];
  const re = /[+-]?\d+(?:\.\d+)?×|[+-]?\d+(?:\.\d+)?%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) out.push(m[0]);
  return out;
}

export function claimNumberTokens(claims: readonly PublicClaim[] = PUBLIC_CLAIMS): Set<string> {
  const out = new Set<string>();
  for (const c of claims) {
    for (const tok of listingNumberTokens(`${c.printed} ${c.statement}`)) out.add(tok);
  }
  return out;
}

/**
 * Skills marketplace listing as a local draft. Rows are PUBLIC_CLAIMS only.
 * Fixture verticals are not customers. Determinism Index stays unpublished.
 */
export function renderClaimsListing(claims: readonly PublicClaim[] = PUBLIC_CLAIMS): string {
  const lines: string[] = [
    CLAIMS_LISTING_BANNER,
    "",
    "# eden-routines (unpublished draft)",
    "",
    "Withheld until a real customer n exists. This file is not a public listing and is not submitted " +
      "anywhere. This draft is not a Determinism Index.",
    "",
    "Every multiplier and percent below is a row in `packages/measure/src/claims.ts` (`PUBLIC_CLAIMS`), " +
      "with the file that measured it. A number that is not on that table must not be printed here. The " +
      "word certified in a limits row means a shadow go-live PASS, not a SOC 2 attestation.",
    "",
  ];

  for (const kind of KIND_ORDER) {
    const rows = claims.filter((c) => c.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${KIND_HEAD[kind]}`);
    lines.push("");
    for (const c of rows) {
      lines.push(`- **${c.name}** (\`${c.printed}\`) — ${c.statement} File: \`${c.file}\`.`);
    }
    lines.push("");
  }

  const approved = claims === PUBLIC_CLAIMS ? customerStudies() : claims.filter((c) => c.approved === true);
  const fixtures = claims === PUBLIC_CLAIMS ? fixtureStudies() : uniqueVerticals(claims);
  const verticals = fixtures.map((c) => c.vertical).filter((v): v is string => typeof v === "string");

  lines.push("## Fixture verticals");
  lines.push("");
  lines.push(
    `Customer-approved measured studies: ${approved.length}. Fixture verticals ` +
      `(${verticals.join(", ") || "none"}) are campaign measurements, not customers. Do not invent a ` +
      `company.`,
  );
  lines.push("");
  lines.push("## Determinism Index");
  lines.push("");
  lines.push(
    "The Determinism Index public page stays unpublished. It needs an n we do not have. ROADMAP §6 " +
      "keeps it pruned. This draft is not that page and does not stand in for it.",
  );
  lines.push("");

  return lines.join("\n");
}

function uniqueVerticals(claims: readonly PublicClaim[]): PublicClaim[] {
  const seen = new Set<string>();
  const out: PublicClaim[] = [];
  for (const c of claims) {
    if (!c.vertical || c.kind !== "win" || c.source !== "campaign") continue;
    if (seen.has(c.vertical)) continue;
    seen.add(c.vertical);
    out.push(c);
  }
  return out;
}
