# Brain-memory bakeoff results

Measured on KEEP Eden (`12ed3ea03`) + new `src/brain-memory.ts` (HCM), full LoCoMo cats 1–4 (1540 Q), **retrieve hit = gold tokens in top-k notes** (not LLM judge).

## Five POCs (retrieve@5 / @20)

| System | Brain analogy | @5 | @20 | cat2 (when) | cat4 |
|---|---|---|---|---|---|
| **ASA** | Hebbian association | 14.8% | 32.7% | 18.7% | 17.2% |
| **TCM** | Episodic time buffer | 31.4% | 44.3% | **24.6%** | 44.0% |
| **CLS** | Hippocampus + cortex | **33.1%** | 46.4% | 23.4% | 47.6% |
| **SCHEMA** | Cortical gist | 29.9% | 43.5% | 20.9% | 42.7% |
| **SALIENCE** | Amygdala tagging | 14.6% | 35.2% | 18.7% | 16.8% |

Stand-ins: **Eden** 33.2% / 42.3% · **BM25-all** 31.2% / 44.4% · **lastk** 2.5% / 3.5%.

## Synthesized HCM (`BrainMemory`)

Routed fusion: Eden-weighted RRF for default questions; dated episodic/TCM for *when* questions.

| System | @5 | @20 | cat2 | cat4 |
|---|---|---|---|---|
| Eden (production extract) | **33.2%** | 42.3% | 6.5% | **52.0%** |
| **HCM / brain-product** | **33.2%** | **49.4–49.7%** | **26.2%** | 45.7–46.3% |
| CLS | 33.1% | 46.4% | 23.4% | 47.6% |

**Takeaway:** HCM **ties Eden @5**, **+7pts @20**, **+10pts @50** (57% vs Eden 47% / BM25 52%), and **4× cat2** by stamping session datetimes into episodic memory — the biggest brain-like win.

Evidence ceiling (gold in top-k notes, full 1540 Q):

| k | Eden | HCM | BM25-all |
|---|---|---|---|
| 5 | 33.2% | 33.2% | 31.2% |
| 20 | 42.3% | **49.4%** | 44.4% |
| 50 | 47.3% | **57.0%** | 52.5% |

## Vendor 92% is not an Eden SOTA claim

Vendor 92% ≠ retrieve@5. It needs:

1. Evidence in a large top-k (HCM @20 already ~50%)
2. **LLM answerer** over those notes
3. **LLM judge** (semantic credit)

Without (2)+(3), no local stack can claim 92%. Do not wire `BrainMemory` into inject hooks. Embeddings and an answerer+judge harness stay bench-only (`LOCOMO-JUDGE.md`). Not the product.

## Files

- `HYPOTHESES.md` — design
- `systems.ts` — five POCs + HCM class used in bench
- `../../../../src/brain-memory.ts` — bench adapter (`openBrainMemory`). Not the product API. Not wrap. Not hook.
- `bench.ts` — reproducible leaderboard → `last-run.json`
