/**
 * M16.2 lane contract — **types only**. No retrieve. Not BrainMemory.
 *
 * Orthogonal mechanisms (mixing them is how M8 assembly still scored FC-MH 7):
 *
 *   ICL index ⟂ AR hops ⟂ SF assemble ⟂ ExperienceStore
 *
 * Hard splits (MEMORY-WAVES.md; Report §7 arithmetic):
 *
 * 1. ICL index is never called from AR hops or SF assembly.
 * 2. Narrative chunks are never run through extractDurable.
 * 3. Facts that overwrite are assembled in **code**, not by asking the generator.
 * 4. Trajectories are files (plus notes/events). Chat JSONL cap 2000 is not the LME store.
 * 5. Still **silent inject**. No `memory_search`. Fail-open. k=10 on Table 3.
 *    No label-strip. No BrainMemory column.
 *
 * Fail-open is a **comment lock only** — this file does not change inject catch.
 * Product loop stays silent inject; there is no memory_search tool.
 */

/** Encode / retrieve lanes. Distinct from packet labels (`MemoryKind` on records). */
export const MEMORY_LANE_KINDS = ["icl", "narrative", "fact", "trajectory", "chat"] as const;

export type MemoryLaneKind = (typeof MEMORY_LANE_KINDS)[number];

/**
 * Orthogonal owner per lane. Later waves add the store files; this map is the
 * isolation contract so ICL extract cannot “fix” EventQA and hops cannot “fix” MCC.
 *
 * - `icl`          → ICL index (atomic exemplars; no graph; no extract)
 * - `narrative`    → store-all 512-token chunks (EventQA). Not GraphRAG. Not AR hops.
 * - `fact`         → SF assemble in code (`max(t)` / `max(serial)` per `(s,p)`)
 * - `trajectory`   → ExperienceStore files (LME), not JSONL
 * - `chat`         → existing JSONL + extractDurable (cap 2000)
 *
 * AR hops are a retrieve overlay for SH/MH (M27–M28), not the narrative encode lane.
 */
export type MemoryLaneMechanism = {
  icl: "icl-index";
  narrative: "chunks";
  fact: "sf-assemble";
  trajectory: "experience-store";
  chat: "chat-jsonl";
};

export type IclIndexMechanism = MemoryLaneMechanism["icl"];
export type ArHopMechanism = "ar-hops";
export type SfAssembleMechanism = MemoryLaneMechanism["fact"];
export type ExperienceStoreMechanism = MemoryLaneMechanism["trajectory"];
export type ChatJsonlMechanism = MemoryLaneMechanism["chat"];

/**
 * ICL index is never called from AR hops or SF assembly.
 * Those callers may not name `"icl-index"` as a callee.
 */
export type IclIndexForbiddenFrom = ArHopMechanism | SfAssembleMechanism;

/**
 * Encode policy. ICL + narrative are store-all (M17 flips extract). Chat still
 * uses extractDurable. Facts that overwrite are assembled in code, not by the
 * generator. Trajectories persist as files; chat JSONL cap 2000 is not LME.
 */
export type MemoryLaneEncode = {
  icl: "store-all";
  narrative: "store-all";
  fact: "code-assemble";
  trajectory: "files";
  chat: "extractDurable";
};

/** Chat JSONL record cap. Not the ExperienceStore / LME haystack. */
export type ChatJsonlCap = 2000;

/**
 * Product locks for every lane. Types / comments only — no inject catch change,
 * no retrieve, no dual-API, no BrainMemory column.
 */
export type MemoryLaneLocks = {
  loop: "silent-inject";
  memorySearch: false;
  failOpen: "comment-only";
  table3K: 10;
  labelStrip: false;
  brainMemoryColumn: false;
};
