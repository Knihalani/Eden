/**
 * Leftover inventory. Doctor prints this; ROADMAP §4.12 must match.
 * Wave 21 honesty files shipped. Wave 22.2 shipped (default jit). Wave 22.1 stays Later (no invoice file).
 * Customer n stays 0.
 */
export type LeftoverStatus = "shipped" | "limit" | "open";
export type LeftoverBand = "16-20" | "21" | "22";

export type Leftover = {
  id: string;
  leftover: string;
  close: string;
  status: LeftoverStatus;
  band: LeftoverBand;
};

/** Every §4.12 row. Status is the close, not a wish. */
export const WAVE_LEFTOVERS: readonly Leftover[] = [
  { id: "soc2-pack", leftover: "SOC2 evidence pack (never a cert claim)", close: "16.1", status: "shipped", band: "16-20" },
  { id: "access-review", leftover: "Access-review exports", close: "16.2", status: "shipped", band: "16-20" },
  { id: "net-allow", leftover: "Doctor EDEN_NET_ALLOW + pool cadence", close: "16.3", status: "shipped", band: "16-20" },
  { id: "zdr-listing", leftover: "ZDR guidance + marketplace draft (unpublished; Index pruned)", close: "16.4", status: "shipped", band: "16-20" },
  { id: "path-identity", leftover: "Relative vs absolute remainder paths; path hint", close: "17.1", status: "shipped", band: "16-20" },
  { id: "hmac-only", leftover: "Raw webhook secret / Bearer still authenticates", close: "17.2", status: "shipped", band: "16-20" },
  { id: "hookd-orphan", leftover: "Orphan hookd; local wrap doesn't start daemon; PreToolUse bun", close: "17.3", status: "shipped", band: "16-20" },
  { id: "installer-home", leftover: "Gemini/Codex/OpenCode EDEN_HOME split-brain", close: "17.4", status: "shipped", band: "16-20" },
  { id: "skills-only-hosts", leftover: "Cursor/Windsurf/Cline hooks", close: "20.4", status: "limit", band: "16-20" },
  { id: "account-onboarding", leftover: "Account / onboarding live (REBUILD 7–14)", close: "18.1", status: "shipped", band: "16-20" },
  { id: "workbench-in-tree", leftover: "Dashboard/canvas/Approve already in tree (15–32)", close: "18.3", status: "shipped", band: "16-20" },
  { id: "waste-in-tree", leftover: "Waste/observability already in tree (33–52)", close: "18.4", status: "shipped", band: "16-20" },
  { id: "live-invoice", leftover: "Live Claude Code invoice / billed S1b cell", close: "19.1", status: "limit", band: "16-20" },
  { id: "oblivious-long", leftover: "wrap oblivious-long +2.8% cents / +3.2% wall", close: "19.2", status: "limit", band: "16-20" },
  { id: "jit-soak", leftover: "JIT soak PASS; default EDEN_SURFACE=jit", close: "19.3 · 21.4 · 22.2", status: "shipped", band: "16-20" },
  { id: "replica-host-drop", leftover: "Replica host-drop of a correct rewrite", close: "19.4", status: "limit", band: "16-20" },
  { id: "customer-n", leftover: "Case studies customer-approved count 0", close: "20.4", status: "limit", band: "16-20" },
  { id: "branch", leftover: "Uncommitted Wave 15+ tree; origin not clean", close: "20.1", status: "shipped", band: "16-20" },
  { id: "catchers-switches", leftover: "Catchers / §15 rows for 16–19", close: "20.2", status: "shipped", band: "16-20" },
  { id: "oblivious-cited-file", leftover: "oblivious-long cites OBLIVIOUS-LONG.md, not ROADMAP", close: "21.1", status: "shipped", band: "21" },
  { id: "isolation-class", leftover: "Isolation Published limits name Kind/Source; analogue and retired own lists", close: "21.2", status: "shipped", band: "21" },
  { id: "proof-cases", leftover: "/proof case-studies use Kind/Source on the wins table chrome", close: "21.3", status: "shipped", band: "21" },
  { id: "claims-header", leftover: "claims.ts header is Wave 21 honesty files", close: "21.1", status: "shipped", band: "21" },
  { id: "jit-soak-remeasure", leftover: "JIT soak remeasure FAIL precision=0.789 n=38; default stays all", close: "21.4", status: "shipped", band: "21" },
  { id: "jit-default", leftover: "EDEN_SURFACE default jit after soak PASS precision=1.000 n=38", close: "22.2", status: "shipped", band: "22" },
];

/** Wave 16–19 phase → mark that §14 and ARC-REGRESSION must contain. */
export const WAVE_16_19_CATCHERS: readonly { phase: string; mark: string }[] = [
  { phase: "16.1", mark: "evidence-pack" },
  { phase: "16.2", mark: "access-review" },
  { phase: "16.3", mark: "doctor-net-allow" },
  { phase: "16.4", mark: "zdr-listing" },
  { phase: "17.1", mark: "cwd-hop" },
  { phase: "17.2", mark: "hmac-only" },
  { phase: "17.3", mark: "hookd-ownership" },
  { phase: "17.4", mark: "installer-home" },
  { phase: "18.1", mark: "account-onboarding" },
  { phase: "18.2", mark: "route-regression" },
  { phase: "18.3", mark: "workbench-review" },
  { phase: "18.4", mark: "waste-layer" },
  { phase: "19.1", mark: "limits-board" },
  { phase: "19.2", mark: "oblivious-long" },
  { phase: "19.3", mark: "jit-soak" },
  { phase: "19.4", mark: "replica-host-drop" },
];

/** Wave 21 honesty-file phases → mark that ARC-REGRESSION must contain. */
export const WAVE_21_CATCHERS: readonly { phase: string; mark: string }[] = [
  { phase: "21.1", mark: "OBLIVIOUS-LONG" },
  { phase: "21.2", mark: "Kind/Source" },
  { phase: "21.3", mark: "ClaimTable" },
  { phase: "21.4", mark: "JIT-SOAK" },
];

/** Wave 22.2 soak PASS → default jit. 22.1 stays Later (no invoice file). */
export const WAVE_22_CATCHERS: readonly { phase: string; mark: string }[] = [
  { phase: "22.2", mark: "surfaceMode_unset=jit" },
];

export function leftoversIn(band: LeftoverBand | "16-20"): Leftover[] {
  if (band === "16-20") return WAVE_LEFTOVERS.filter((r) => r.band === "16-20");
  return WAVE_LEFTOVERS.filter((r) => r.band === band);
}

export function openLeftovers(band: LeftoverBand | "16-20" | "21-22"): Leftover[] {
  if (band === "21-22") {
    return WAVE_LEFTOVERS.filter((r) => (r.band === "21" || r.band === "22") && r.status === "open");
  }
  return leftoversIn(band).filter((r) => r.status === "open");
}

export function treeSnapshot(): {
  open16_20: number;
  shipped16_20: number;
  limit16_20: number;
  open21_22: number;
  customers: 0;
  closed: boolean;
} {
  const rows = leftoversIn("16-20");
  const open16_20 = rows.filter((r) => r.status === "open").length;
  return {
    open16_20,
    shipped16_20: rows.filter((r) => r.status === "shipped").length,
    limit16_20: rows.filter((r) => r.status === "limit").length,
    open21_22: openLeftovers("21-22").length,
    customers: 0,
    closed: open16_20 === 0,
  };
}

/** First line a person can read. Chromium-shaped: closed or open, then why. */
export function renderTreeLetter(rows: readonly Leftover[] = WAVE_LEFTOVERS): string {
  const snap = treeSnapshot();
  const later = rows.filter((r) => r.band === "21" || r.band === "22");
  const lines: string[] = [
    snap.closed ? "Tree closed — Wave 16–20" : `Tree open — Wave 16–20 ${snap.open16_20} leftover${snap.open16_20 === 1 ? "" : "s"}`,
    "",
    `${snap.open16_20} open · ${snap.shipped16_20} shipped · ${snap.limit16_20} limit`,
    "Wave 21 closed",
    "Wave 22.2 shipped · 22.1 Later (no invoice file)",
    "",
    "Cursor/Windsurf/Cline  skills-only until a hook API",
    "Customer studies       0",
    "Human Approve          required",
    "EDEN_AUTO_APPROVE      off (scrubbed on managed)",
    "",
  ];
  if (!snap.closed) {
    lines.push("Open (Wave 16–20)");
    lines.push("");
    for (const r of leftoversIn("16-20").filter((r) => r.status === "open")) {
      lines.push(`- ${r.close}  ${r.leftover}`);
    }
    lines.push("");
  }
  lines.push("Wave 21 (honesty files)");
  lines.push("");
  for (const r of later.filter((x) => x.band === "21")) {
    lines.push(`- ${r.close}  ${r.leftover}  (${r.status})`);
  }
  lines.push("");
  lines.push("Wave 22.2 (default jit)");
  lines.push("");
  const w22 = later.filter((x) => x.band === "22");
  if (!w22.length) {
    lines.push("(none)");
  } else {
    for (const r of w22) {
      lines.push(`- ${r.close}  ${r.leftover}  (${r.status})`);
    }
  }
  lines.push("");
  lines.push("Later (Wave 22.1 — no invoice file)");
  lines.push("");
  lines.push("(none until a live Claude Code invoice parses)");
  lines.push("");
  return lines.join("\n");
}

export function treeCheck(): { name: "tree"; ok: boolean; count: number; detail: string } {
  const snap = treeSnapshot();
  if (!snap.closed) {
    return {
      name: "tree",
      ok: false,
      count: snap.open16_20,
      detail: `Wave 16–20 ${snap.open16_20} open · not closed`,
    };
  }
  return {
    name: "tree",
    ok: true,
    count: 0,
    detail: `Wave 16–20 0 open · ${snap.shipped16_20} shipped · ${snap.limit16_20} limit · Wave 21 closed · Wave 22.2 shipped`,
  };
}

/** Default off. Managed installs scrub it. Doctor names the bypass. */
export function autoApproveCheck(raw: string | undefined = process.env.EDEN_AUTO_APPROVE): {
  name: "approve-gate";
  ok: boolean;
  detail: string;
} {
  if (String(raw ?? "").trim() === "1") {
    return { name: "approve-gate", ok: false, detail: "EDEN_AUTO_APPROVE on · human gate bypassed" };
  }
  return { name: "approve-gate", ok: true, detail: "human Approve required · EDEN_AUTO_APPROVE off" };
}
