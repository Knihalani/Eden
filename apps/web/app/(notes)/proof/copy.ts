/**
 * Proof / case-study copy.
 *
 * Numbers live in PUBLIC_CLAIMS. This module maps over that table.
 * Do not paste a multiplier or percent here.
 */
import { claimsOf, customerStudies, fixtureStudies, type PublicClaim } from "@eden/measure";

export type { PublicClaim };

export const WINS = claimsOf("win");
export const PARITY = claimsOf("parity");
export const ANALOGUE = claimsOf("analogue");
export const LIMITS = claimsOf("limit");
export const RETIRED = claimsOf("retired");
export const FIXTURES = fixtureStudies();
export const CUSTOMERS = customerStudies();

export const PROOF_LEAD =
  "Campaign cells are paired and counterbalanced, with an A/A self-check, in packages/measure. WIN and LOSS are decide() verdicts. Negative-control parity is ±1%, registered once and never moved after seeing a result. Every number on this page cites the file that measured it.";

export const PROOF_NOT =
  "Nothing public without methodology. UNCERTIFIED is never a win. Analogue cents are labeled analogue, not a live Claude Code invoice. Limits and retired claims print with the same file path as the wins. This page is not a landing badge.";

export const CASES_LEAD =
  "These are campaign fixture verticals, not customers. Customer-approved measured studies: 0. Unpublished slots stay empty. No company names. Kind and Source use the same table chrome as the wins table so this cannot be read as a second unlabeled win board.";

export const WINS_NOTE = "Campaign WINs from packages/measure. Replica analogue cents are not in this table.";

export const PARITY_NOTE = "Negative-control parity at ±1%. Same files, same rigor as the wins.";

export const ANALOGUE_NOTE = "Headless replica TURN_CENTS. Not a live Claude Code invoice. Not a campaign WIN.";

export const LIMITS_NOTE = "OOD, oblivious agents, certification bounds, host limits. Equal weight with the wins.";

export const RETIRED_NOTE = "Claims withdrawn in public until a file parses. Retired is a result.";

export const PROOF_COUNTS = `${WINS.length} wins · ${PARITY.length} parity · ${ANALOGUE.length} analogue · ${LIMITS.length} limits · ${RETIRED.length} retired · ${CUSTOMERS.length} customers`;
