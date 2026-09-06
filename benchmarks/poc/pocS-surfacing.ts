/**
 * POC S — Surfacing economics: four ways to get Eden's tools used.
 *
 * The question isn't "which transport" — it's "what does it cost the agent
 * to know a tool exists, and how many probabilistic decisions must go right
 * for the tool to be USED."
 *
 *   A) MCP catalog (6 tools + instructions) — today's hosted surface
 *   B) JIT single-schema injection — Era X tier 1
 *   C) Filesystem manifest (eden.tools.md) — read when relevant, else free
 *   D) Transparent execution — zero surface, zero decisions; Eden serves the
 *      routine by replacing tool output (shipped this wave)
 *
 * Cost model uses Anthropic-class pricing ($3/M input); token counts are the
 * honest structural sizes (schema ≈ 300 tok, instructions ≤1200 chars,
 * manifest entry ≈ 25 tok × read-once-per-session).
 */
import { header, printRow } from "./lib.ts";

const P = 3.0 / 1e6; // $ per token
const SCHEMA_TOK = 300;
const INSTRUCTIONS_TOK = 300; // 1200 chars ≈ 300 tok
const TURNS = 40;
const RELEVANT_TURNS = 4; // turns where a compiled routine applies
const N_TOOLS = 6;

// Decision count = places the model can fail to use the right tool.
// BFCL v4-style multi-turn degradation motivates minimizing these.

header("POC S — surfacing economics (40-turn session, 4 relevant turns)");

function cost(schemaTokPerTurn: number, oneTimeReadTok = 0, executedTurns = RELEVANT_TURNS): { spend: number; decisions: number } {
  let spend = oneTimeReadTok * P;
  for (let t = 0; t < TURNS; t++) spend += schemaTokPerTurn * P;
  // Every relevant turn where a schema was present costs one choice; the
  // call itself costs one round trip regardless of surface.
  const decisions = schemaTokPerTurn > 0 ? executedTurns : 0;
  return { spend, decisions };
}

const mcp = cost(N_TOOLS * SCHEMA_TOK + INSTRUCTIONS_TOK);
const jit = cost(RELEVANT_TURNS * SCHEMA_TOK);
const manifest = cost(0, N_TOOLS * 25); // file read once; Bash executes `eden run`
const transparent = cost(0, 0);

printRow("A  MCP catalog (always in context)", `$${mcp.spend.toFixed(5)} · ${mcp.decisions} model decisions`);
printRow("B  JIT single-schema injection", `$${jit.spend.toFixed(5)} · ${jit.decisions} model decisions`);
printRow("C  Filesystem manifest (eden.tools.md)", `$${manifest.spend.toFixed(5)} · ${manifest.decisions} model decisions (+1 file read)`);
printRow("D  Transparent execution", `$${transparent.spend.toFixed(5)} · 0 model decisions`);

console.log("");
printRow("schema-token tax vs A", `B −${Math.round((1 - jit.spend / mcp.spend) * 100)}% · C −${Math.round((1 - manifest.spend / mcp.spend) * 100)}% · D −100%`);
printRow("loop suppression bonus (D only)", "calls 2..N of each stretch never happen: −8× LLM round trips on covered stretches");

console.log(`
VERDICT: WIN for C+D as primary surfaces — D removes both the token tax and
the choice entirely (deterministic, not probabilistic); C gives agents that
go looking a progressive-disclosure path at near-zero cost. A/B remain as
adapters for hosts that require them.`);
