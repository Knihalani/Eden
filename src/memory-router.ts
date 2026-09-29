/**
 * M30.3 competency router — MIRIX take (§4.7): steal the router
 * (ICL vs needle vs overwrite vs summary vs dialogue). Leave six ontologies.
 *
 * Not six MIRIX ontologies. Not a memory tool. Do not add memory_search.
 * Cue string only — no disk, no LLM, no network, no retrieve.
 * Plan §0 silent inject. M33 wires this onto AgentMemory.relevant. Fail-open.
 *
 * Wired onto AgentMemory.relevant (one lane per cue). Do not import from wrap/hook as a tool.
 */

export type MemoryRoute = "gist-chunk" | "icl-index" | "sf-assemble" | "chat-jsonl";

/** Tiny isIclExemplar duplicate (`label:` / input:+output: pair). Do not import BrainMemory.
 * Lone `Output:` is DetQA's official fill-in suffix, not MCC.
 */
const ICL_RE = /\blabel\s*:/i;
const ICL_INPUT_RE = /\binput\s*:/i;
const ICL_OUTPUT_RE = /\boutput\s*:/i;

const SUMMARY_RE = /\b(?:summarize|summary|summarise|tldr|recap|overview|synopsis|abstract)\b/i;
const DETQA_MEMORIZED_RE = /based on the context you memorized/i;
const DETQA_MC_RE = /\bA\.\s+[\s\S]*\bB\.\s+[\s\S]*\bC\.\s+[\s\S]*\bD\./;
const DETECTIVE_RE =
  /\b(?:murder(?:er)?|detective|victim|suicide|homicide|killed|killer|suspect|alibi|poison|corpse|culprit|whodunit|inspector|forensic|method of death)\b/i;

const SERIAL_FACT_RE = /(?:^|\n)\s*\d+[.)]\s+.+\b(?:is|are|was|were|became|becomes)\b/i;
const BECAME_RE = /\b(?:became|becomes|instead)\b/i;
const WHO_IS_THE_RE = /\bwho\s+is\s+the\b/i;
/** "Auth is Clerk" — both sides look like names/products, not status ("Auth is failing"). */
const PROPER_IS_PROPER_RE = /\b[A-Z][A-Za-z0-9]+\s+is\s+[A-Z][A-Za-z0-9]+\b/;
/** "The chairperson is Bob" / "The chairperson of the committee is Alice". */
const THE_ROLE_IS_NAME_RE = /\b[Tt]he\s+[a-z][a-z\s]{0,60}?\s+is\s+[A-Z][A-Za-z0-9]+\b/;

function looksCodeInput(text: string): boolean {
  const m = text.match(/\binput\s*:\s*([^\n]+)/i);
  const v = m ? m[1]!.trim() : "";
  if (!v) return false;
  return /[\\/]/.test(v) || /^src\b/i.test(v) || /\.(?:ts|tsx|js|jsx|py|go|rs)\b/i.test(v);
}

function isIclCue(text: string): boolean {
  if (ICL_RE.test(text)) return true;
  if (ICL_INPUT_RE.test(text) && ICL_OUTPUT_RE.test(text) && !looksCodeInput(text)) return true;
  return false;
}

function isQuestion(text: string): boolean {
  if (/\?/.test(text)) return true;
  if (/\bquestion\s*:/i.test(text)) return true;
  return /^\s*(?:who|what|where|when|why|how|which)\b/i.test(text);
}

function isGistCue(text: string): boolean {
  if (SUMMARY_RE.test(text)) return true;
  if (DETQA_MEMORIZED_RE.test(text)) return true;
  if (DETQA_MC_RE.test(text)) return true;
  // Detective-novel QA only — EventQA miller is AR/narrative BM25, not DetQA.
  if (isQuestion(text) && DETECTIVE_RE.test(text)) return true;
  return false;
}

function isOverwriteCue(text: string): boolean {
  if (SERIAL_FACT_RE.test(text)) return true;
  if (BECAME_RE.test(text)) return true;
  if (WHO_IS_THE_RE.test(text)) return true;
  if (PROPER_IS_PROPER_RE.test(text)) return true;
  if (THE_ROLE_IS_NAME_RE.test(text)) return true;
  return false;
}

/**
 * Fail-open: throw → "chat-jsonl". Never throws. No tools. Not six MIRIX stores.
 * Priority: ICL, then gist-chunk (summary/book), then sf-assemble, else chat.
 */
export function routeMemory(cue: string): MemoryRoute {
  try {
    const text = String(cue ?? "");
    if (!text.trim()) return "chat-jsonl";
    if (isIclCue(text)) return "icl-index";
    if (isGistCue(text)) return "gist-chunk";
    if (isOverwriteCue(text)) return "sf-assemble";
    return "chat-jsonl";
  } catch {
    return "chat-jsonl";
  }
}
