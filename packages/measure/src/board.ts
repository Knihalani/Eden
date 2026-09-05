/**
 * Terminal / notes board for PUBLIC_CLAIMS (Wave 21 honesty files).
 *
 * Limits, analogue, and retired print with the same file path as wins.
 * A number that is not on PUBLIC_CLAIMS must not be invented here.
 */
import {
  PUBLIC_CLAIMS,
  customerStudies,
  type ClaimKind,
  type PublicClaim,
} from "./claims";

export const BOARD_KIND_ORDER: ClaimKind[] = ["win", "parity", "analogue", "limit", "retired"];

export const BOARD_KIND_HEAD: Record<ClaimKind, string> = {
  win: "Wins",
  parity: "Parity",
  analogue: "Analogue",
  limit: "Limits",
  retired: "Retired",
};

export function claimsForKind(
  kind: ClaimKind | "all",
  claims: readonly PublicClaim[] = PUBLIC_CLAIMS,
): PublicClaim[] {
  if (kind === "all") return [...claims];
  return claims.filter((c) => c.kind === kind);
}

export function parseClaimsKind(raw: string | undefined): ClaimKind | "all" | null {
  const v = String(raw ?? "all").trim().toLowerCase();
  if (!v || v === "all") return "all";
  if (v === "win" || v === "wins") return "win";
  if (v === "parity") return "parity";
  if (v === "analogue" || v === "analog") return "analogue";
  if (v === "limit" || v === "limits") return "limit";
  if (v === "retired") return "retired";
  return null;
}

export function boardCounts(claims: readonly PublicClaim[] = PUBLIC_CLAIMS): {
  wins: number;
  parity: number;
  analogue: number;
  limits: number;
  retired: number;
  customers: number;
} {
  return {
    wins: claims.filter((c) => c.kind === "win").length,
    parity: claims.filter((c) => c.kind === "parity").length,
    analogue: claims.filter((c) => c.kind === "analogue").length,
    limits: claims.filter((c) => c.kind === "limit").length,
    retired: claims.filter((c) => c.kind === "retired").length,
    customers: customerStudies().length,
  };
}

export function boardSummaryLine(claims: readonly PublicClaim[] = PUBLIC_CLAIMS): string {
  const n = boardCounts(claims);
  return `${n.wins} wins · ${n.parity} parity · ${n.analogue} analogue · ${n.limits} limits · ${n.retired} retired · ${n.customers} customers`;
}

/**
 * Letter a person can read. Counts first, then groups, then files.
 * Kind/source sit on the same line as the printed meter so a limit cannot
 * be mistaken for a win.
 */
export function renderClaimsBoard(
  claims: readonly PublicClaim[] = PUBLIC_CLAIMS,
  opts: { kind?: ClaimKind | "all" } = {},
): string {
  const kind = opts.kind ?? "all";
  const rows = claimsForKind(kind, claims);
  const n = boardCounts(claims);
  const lines: string[] = [
    "eden claims — published limits board",
    "",
    boardSummaryLine(claims),
    "",
    "Limits sit beside wins. A retired cell is a result. Analogue cents are analogue, not a live Claude Code invoice.",
    "",
  ];
  if (!rows.length) {
    lines.push("0 rows.");
    lines.push("");
    return lines.join("\n");
  }
  const kinds = kind === "all" ? BOARD_KIND_ORDER : [kind];
  for (const k of kinds) {
    const group = rows.filter((c) => c.kind === k);
    if (!group.length) continue;
    lines.push(`${BOARD_KIND_HEAD[k].toUpperCase()}`);
    for (const c of group) {
      lines.push(`  ${c.name}`);
      lines.push(`    ${c.printed} · ${c.kind} · ${c.source}`);
      lines.push(`    ${c.statement}`);
      lines.push(`    ${c.file}`);
    }
    lines.push("");
  }
  lines.push(`Customer-approved measured studies: ${n.customers}.`);
  lines.push("");
  return lines.join("\n");
}
