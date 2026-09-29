# Brain-inspired memory systems (path to Mem0-class ~92%)

**Superseded 2026-09-16.** Product plan is `docs/MEMORY-PLAN.md`. LoCoMo 92 is an **anti-goal** (gold 6.4% dirty; judge ~63% false-accept; ceiling ~93.6%). Independent LoCoMo J is a once-run regression after evidence exists, target ≥75 not 92. This file remains as bakeoff history of five retrieval hypotheses (ASA/TCM/CLS/SCHEMA/SALIENCE → HCM). Do not optimize retrieve@5 against it.

Vendor **92% LoCoMo** is retrieve + **answerer LLM** + **judge LLM**, often with large top-k.
Our bakeoff’s retrieve@5 is a different number. These systems attack both: denser evidence
in context **and** brain-like surfacing so an answerer can hit judge-grade scores.

## Five hypotheses

### 1. Associative Spreading Activation (ASA) — *association cortex / Hebbian*
Co-occurring entities and content tokens form an undirected weighted graph. A query
activates matching nodes; activation spreads one hop. Notes are scored by total
activation mass on their tokens. **Brain analogy:** cue → related engrams fire together.

### 2. Temporal Context Model (TCM) — *episodic buffer / hippocampal time*
Each turn inherits a drifting temporal context and an explicit **session datetime**
stamp (LoCoMo `session_*_date_time`). Retrieval mixes lexical overlap with temporal
proximity and date-token matches. **Brain analogy:** “when” is part of the engram.

### 3. Complementary Learning Systems (CLS) — *hippocampus + neocortex*
Fast store: keep **every** turn (episodic). Slow store: Eden-style durable extract
(semantic). Fuse with Reciprocal Rank Fusion. **Brain analogy:** CLS dual-memory.

### 4. Schema + Exemplar (SCHEMA) — *cortical schemas*
Per-speaker **profiles** accumulate durable lines; queries that name a person boost
that profile plus matching exemplars. **Brain analogy:** gist scaffolds detail recall.

### 5. Salience-Weighted Consolidation (SALIENCE) — *amygdala / replay*
Notes get a salience prior: rare tokens, proper names, digits, repetition, length.
High-salience items stay “pinned” and get a retrieve prior. **Brain analogy:**
emotionally/goal-tagged memories are preferentially replayed.

## Synthesis: Hippocampal–Cortical Memory (HCM)

HCM composes all five:

1. **Episodic lane** — all dated turns (TCM stamps)
2. **Semantic lane** — Eden durable extract (CLS slow store)
3. **Schema lane** — speaker profiles (SCHEMA)
4. **Graph lane** — spreading activation over entity co-occurrence (ASA)
5. **Salience prior** on episodic notes (SALIENCE)
6. **RRF fuse** of BM25(episodic) + Eden(semantic) + profile hits + graph scores
7. Optional **answerer** (Ollama/OpenAI) over top-k for judge-style scoring

Product claim: never drop session time or speaker identity; surface by association,
time, gist, and salience — not bag-of-words alone.
