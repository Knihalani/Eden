# Completeness without drowning

**Locked 2026-09-28.** Product intent: the user should not have to restate anything already given; the injected block stays ≤8 / ≤900 and **gold first**. Dump-all stays a miss. No embeddings on submit.

Two stores, one brain:

| Store | Never | How |
|---|---|---|
| Disk (hippocampus) | Forget a raw turn | Append episodes; invalidate copula *values*; heat only ranks |
| Packet (working set) | Drown the model | Posting hit only; fact > episode; rarest-token first; skip-not-evict |

Silence on a true miss is correct. Stuffing the log is not.

## Write

1. Chat still runs `extractDurable` (copulas, rules, pins).
2. If extract covers < 85% of the turn (or nothing), **also** `remember` the redacted raw blob as `kind: "episode"`. Chatter / math (`isNoopCue`) still store nothing.
3. Questions store as episodes, not facts. Retrieve still runs before this-turn encode.
4. Aliases live on the row (`writeAliasTags`). Cue-time synonym expand stays gone.

## Read

1. `relevant`: inverted postings only. Empty posting list → `[]`.
2. Rank: overlap + IDF of matched tokens (short posting list = rarer) + kind (rule > procedure > fact > episode) + heat + recency.
3. `goldFirstNotes(cue, notes)` reorders the retrieved list so notes that own the rarest cue token (especially copulas) sit in front of pack. Hop cues keep assemble order.
4. Align copulas to live SemanticStore *before* gist prefer, so instead-of tails and stale gists cannot empty the packet.
5. `packNotes` skip-not-evict, ≤ min(8, k), ≤ 900 B.

## Sleep

1. Heat decay does not delete. Losing *fact* JSONL rows may still drop; **episodes do not**.
2. `miss.jsonl` is applied: Encode → tags + loose copula put; Store → `SemanticStore.put`; Retrieve → tags/postings; Maintain → already `invalidAt`.
3. Sleep postings remain lexical. No embedder.

## Refuse

Embeddings on UserPromptSubmit, whole-store score, LLM extract/reflect, growing the packet until every past turn fits.
