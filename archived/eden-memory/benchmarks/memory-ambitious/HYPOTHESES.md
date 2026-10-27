# Ambitious memory — hypotheses

**Lock:** surface a needed point when the turn needs it. Fat packet OK. Silence only math/chatter. Silent inject (no `memory_search`). Fail-open. Flag `EDEN_MEMORY_X`; default inject unchanged.

Inspired by RippleMem (associative recollection from first hits), hippocampal CA3 pattern completion, MemGPT core memory, HippoRAG association **without** GraphRAG EventQA.

## Ideas tested

| id | Mechanism | Predicted failure |
|---|---|---|
| cluster | Expand login→auth (CUE_LEX) on **facts**, not only intentions | Over-fire on math if “plus” clusters. Did not. |
| ripple | Second `relevant` pass using tokens from first hits | Echo / no-op if first miss. H1 ablation: no-op. |
| union | How-to + experience even on sf-assemble / gist routes | ICL pollution. Not this fixture set. |
| identity | Pins + live semantic on every non-math cue (core memory) | Always-on project dump. H1 win if Clerk is pinned. |
| fat | ~2400 char budget instead of dropping gold at k=6 | Token blowup. H12 +1334 B, both golds present. |
| mathsilent | Skip `EDEN_MEMORY_MIN` except math/chatter | Leak sqlite on 2+2. Did not. |
| nofilter | Do not drop wrap rows when hook `project=cwd` | Cross-project bleed. H8 already hit on default. |
| aurora | all of the above | Harbor-style token tax if always-on. Math still omits. |

## Falsified / not this pass

- Ripple without a first hit cannot rescue a lexical miss (H1).
- GraphRAG, Mem0 extract, k=40 MCC, always-on TB: already falsified in-plan; not re-run.
- Encode allow-list: H9 was a **silence** miss, not a drop. “Pin Clerk…” was stored; MIN omitted it.

## Result (2026-09-25)

Needed-and-present **6/10 → 10/10**. Math/chatter omit **2/2 → 2/2**.

H1 ablation: **cluster** or **identity** is sufficient. mathsilent/ripple/fat/union/nofilter alone do not win paraphrase.

Default remains off. Enable with `EDEN_MEMORY_X=aurora` (or `cluster,identity,fat,mathsilent`).
