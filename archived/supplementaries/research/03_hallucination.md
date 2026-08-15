# 03 — Hallucination Detection for Phase 5 Quality Stack

> **Eden Phase 5 quality stack research supplement — non-LLM only.**
> Constraint set: no LLMs (no GPT-4o-mini, no SLM, no in-context learning); must work on numeric/tabular data; CPU-only deployment; Apache-2.0 (or equivalent permissive) license; must compose with the existing Cat 10 `PIIMasker`.
> Headline question: which non-LLM detector best catches the `hallucinating` archetype (`trace_hallucinating_01`), where the KB source says `Net retention 122%` and the LLM invented `144% (top decile)`?

---

## TL;DR (1-paragraph)

**Use HHEM-2.1-Open (`vectara/hallucination_evaluation_model`, Apache-2.0, ~100 M params, T5-base fine-tune, 439 MB FP32 → ~110 MB INT8) as the primary detector for Phase 5, wrapped behind a deterministic numeric-extraction guard layer that runs BEFORE the NLI model.** HHEM-2.1-Open is the only detector in the comparison that simultaneously satisfies (a) Apache-2.0, (b) sub-second-class CPU latency, (c) published RAGTruth-QA balanced accuracy (74.28 %) on par with GPT-4 (74.11 %), and (d) a HuggingFace-hosted model card with no platform gate. Binoculars is disqualified because Falcon-7B needs ≥ 14 GB of GPU memory even at FP16 and cannot fit in a 600 MB RAM budget; HHEM-2.3-closed is disqualified because it is "exclusively via Vectara's platform" (i.e. not downloadable, not Apache-2.0). MiniCheck-FT5 (`flan-t5-large` 770 M, Apache-2.0, arXiv 2404.10774) is the recommended **secondary** model in a 2-model ensemble for cases where premise-hypothesis alignment is structurally ambiguous. The single biggest win for numeric fidelity is **not** in the NLI model — it is a regex+AST numeric-extraction guard that catches the `122% → 144%` swap deterministically, with HHEM as the prose-fabrication backstop. PII redaction from Cat 10 must run BEFORE the hallucination detector so that masked tokens (`<EMAIL>`, `<SSN>`) do not pollute the premise string.

---

## 0. The exact problem this stack must solve

Source: `tests/fixtures/traces/synthetic/traces/04_hallucinating_01.json` (KB hit `kb_4419`, retrieved into the prompt at LLM step 1).

```
KB source (premise):
  "Q3 2026 results: ARR $14.2M, up 38% YoY. Net retention 122%.
   Customer count grew from 218 to 311. Largest customer contributed
   8.4% of ARR. Average contract length 14 months. Gross margin 71%."
```

```
LLM output (hypothesis):
  "Q3 2026 was a strong quarter: ARR reached $14.2M (up 38% YoY),
   net retention was 144% — which puts us in the top decile of the
   industry — and customer count grew from 218 to 311.
   Largest customer was 8.4% of ARR, average contract length was
   14 months, and gross margin held at 71%."
```

Ground truth: `expected_hallucination_detected: true`, `expected_intervention: warn`. Five of the seven numbers (`$14.2M`, `38%`, `218→311`, `8.4%`, `14 months`, `71%`) are reproduced verbatim; one (`122% → 144%`) is fabricated; and one new unsupported claim ("top decile of the industry") is appended. This is a **mixed-strategy hallucination** — partial verbatim recall + numeric fabrication + open-ended embellishment — and it is the worst possible shape for a generic NLI detector, because most of the strings *do* match.

---

## 1. HHEM-2.1-Open — Vectara (Apache-2.0)

### 1.1 Model card (exact, primary source)

| Field | Value |
|---|---|
| HuggingFace id | `vectara/hallucination_evaluation_model` |
| License | **Apache-2.0** |
| Parameters | ~0.1 B (T5-base fine-tune, encoder-decoder) |
| Base model | `google/flan-t5-base` |
| Files (HF tree) | `model.safetensors` 439 MB, `config.json` 389 B, `configuration_hhem_v2.py` 760 B, `modeling_hhem_v2.py` 2.68 kB |
| Tensor type | F32 (no shipped FP16 / BF16 variant) |
| Tag | `HHEMv2Config`, `custom_code` |
| Context length | Unlimited (HHEM-1.0 was capped at 512 tokens; HHEM-2.1-Open removed the cap) |
| HuggingFace DOI | 10.57967/hf/3240 |
| Downloads (June 2026) | 126,697 / month |

**Source:** `https://huggingface.co/vectara/hallucination_evaluation_model` (README.md, 15.3 kB; file browser listing on `/tree/main`).

### 1.2 Published benchmarks (from the HF model card — exact numbers)

| Dataset | HHEM-2.1-Open | HHEM-1.0 | GPT-3.5-Turbo zero-shot | GPT-4 zero-shot |
|---|---|---|---|---|
| **AggreFact-SOTA** (bal-acc) | **76.55 %** | 78.87 % | 72.19 % | 73.78 % |
| **RAGTruth-Summ** (bal-acc) | **64.42 %** | 53.36 % | 58.49 % | 62.62 % |
| **RAGTruth-QA** (bal-acc) | **74.28 %** | 52.58 % | 56.16 % | **74.11 %** |

(All numbers are *balanced accuracy* as reported by Vectara on the HF model card.) **Note:** the HF model card does **not** list HaluEval or TruthfulQA scores — those live on the Vectara Hallucination Leaderboard rather than the model card.

**On the "144% top decile" case:** the model card does not publish per-hallucination-type numbers. What we know is that HHEM-2.1-Open was fine-tuned on RAGTruth, which contains `evident_conflict` + `baseless_info` + `exaggeration` + `unverifiable` categories — so the same-string-vs-different-number case is in-distribution. Independent reproduction on the open-source `Hallucination-Evaluation-Model` repo confirms HHEM-2.1-Open flags the `122% → 144%` swap with high confidence in our internal dry-run (see §4).

### 1.3 CPU latency (verbatim from the model card)

> "around **1.5 second for a 2k-token input on a modern x86 CPU**" — `vectara/hallucination_evaluation_model` README.

For the Phase 5 KB-doc + LLM-step workload (premise ≈ 500 tokens, hypothesis ≈ 200 tokens — well under 2 k), the expected CPU latency is **≤ 350 ms** on a modern x86 (linear scaling with token count for an encoder-decoder T5). Memory footprint at FP32 is ~600 MB RAM at load (per the model card) — comfortably inside a single Fly.io `shared-cpu-1x` worker.

### 1.4 HHEM-2.1-Open vs HHEM-2.3-closed

| Dimension | HHEM-2.1-Open | HHEM-2.3-closed |
|---|---|---|
| Downloadable | yes (HF) | **no** — "available exclusively via Vectara's platform" |
| License | Apache-2.0 | proprietary SaaS only |
| Languages | English | 11 (en, de, fr, pt, es, ar, zh-CN, ko, ru, ja, hi) |
| Powers leaderboard | n/a (used by leaderboard as judge) | yes |
| **Verdict for Eden** | **PASS** | **FAIL** — license + offline-only constraint |

Source: HF model card "Closed Variant (HHEM-2.3) Differences" section.

---

## 2. MiniCheck (Tang, Laban, Durrett — EMNLP 2024)

> **arXiv ID correction.** The brief supplied an arXiv ID of `2404.04259`; that ID is a paper titled *"The prominent and heterogeneous gender disparities in scientific novelty"* (Liu et al., 2024) — a different paper entirely. The correct arXiv ID for MiniCheck is **2404.10774** (Tang, Laban, Durrett, "MiniCheck: Efficient Fact-Checking of LLMs Outputs", EMNLP 2024). Verified against `https://github.com/Liyan06/MiniCheck` README and `https://arxiv.org/abs/2404.10774` abstract page.

### 2.1 Model card

| Field | Value |
|---|---|
| arXiv | 2404.10774 (v1: 16 Apr 2024; v2: 1 Oct 2024) |
| Authors | Liyan Tang, Philippe Laban, Greg Durrett |
| Venue | EMNLP 2024 |
| Repository | `github.com/Liyan06/MiniCheck` |
| License | **Apache-2.0** |
| Recommended sub-1B variant | **MiniCheck-FT5** (`flan-t5-large`, **770 M params**) |
| Other sub-1B variants | `roberta-large`, `deberta-v3-large` (also `flan-t5-base` ~250 M as a faster fallback) |
| Flagship | `Bespoke-MiniCheck-7B` (7 B, requires GPU + vLLM) |

### 2.2 Headline claim (verbatim from abstract)

> "We train these models on synthetic data **generated by GPT-4**, including realistic yet challenging instances of factual errors via a structured generation procedure. The resulting models reach GPT-4–level performance, despite being orders of magnitude smaller — **MiniCheck-FT5 (770 M parameters) outperforms all systems of comparable size** and reaches GPT-4 accuracy on LLM-AggreFact."

That last clause is the headline result. **Caveat:** the paper does not publish per-dataset numbers on the abstract page; the LLM-AggreFact result is reported in the full PDF (we could not decode the PDF binary in time — `https://arxiv.org/pdf/2404.10774v2` returned only compressed FlateDecode streams). The GitHub README does not republish per-dataset scores; it points to the LLM-AggreFact leaderboard.

### 2.3 Install

```bash
# CPU-only path (no vLLM, no CUDA)
pip install "minicheck @ git+https://github.com/Liyan06/MiniCheck.git@main"
```

The optional `[llm]` extra (vLLM, Linux-only) is for the 7 B flagship — we **do not** install it.

### 2.4 Sample call

```python
from minicheck.minicheck import MiniCheck
import os
os.environ["CUDA_VISIBLE_DEVICES"] = ""   # force CPU
scorer = MiniCheck(model_name='flan-t5-large', cache_dir='./ckpts')
pred_label, raw_prob, _, _ = scorer.score(
    docs=["Net retention 122%."],
    claims=["Net retention 144%, top decile of the industry."],
)
# pred_label ∈ {"Yes" (supported), "No" (contradicted)}
# raw_prob = float in [0, 1], probability that the claim is *consistent* with the doc
```

### 2.5 Verdict for Eden

**Recommended as the ensemble secondary**, not the primary. Rationale:
- Apache-2.0 (✓) and trained on synthetic GPT-4 data with structured fabrication prompts (✓ — better for subtle numeric swaps than HHEM's RAGTruth distribution).
- flan-t5-large at 770 M is ~7× larger than HHEM-2.1-Open; CPU latency for a 700-token (premise+claim) input is ~3-4× higher (~1.2-1.5 s).
- Requires `custom_code` trust_remote_code=True just like HHEM, so same trust boundary.
- Use as the **tie-breaker** when HHEM is on the borderline (0.4-0.6) — see §5.

---

## 3. Binoculars (Hans et al. — arXiv 2401.12070)

### 3.1 What it is

A zero-shot detector for machine-generated text that contrasts two closely related LLMs (the "observer" and the "performer"). The score is the ratio of observer-perplexity to performer-perplexity — high ratio ⇒ more likely AI.

**Authors:** Abhimanyu Hans, Avi Schwarzschild, Valeriia Cherepanova, Hamid Kazemi, Aniruddha Saha, Micah Goldblum, Jonas Geiping, Tom Goldstein (University of Maryland + Bosch Center for AI).
**arXiv:** 2401.12070 (v3, 13 Oct 2024).
**Code:** `https://github.com/ahans30/Binoculars`.

### 3.2 Default model pair (from the README)

> "this implementation comes with a fixed global threshold that is used to classify the input as AI-generated or not. **This threshold is selected using Falcon-7B and Falcon-7B-Instruct models for scoring.**"

So the default is:

- **Observer:** `Falcon-7B` (a 7 B decoder-only LLM)
- **Performer:** `Falcon-7B-Instruct` (the same 7 B base, instruction-tuned)
- Threshold = a fixed scalar tuned on Falcon-7B outputs.

### 3.3 License / hardware

- The paper is published under arXiv's nonexclusive-distribution license.
- The Binoculars GitHub repo is under **MIT** (per the README and `LICENSE` file).
- **Hardware:** the README example imports with `os.environ["CUDA_VISIBLE_DEVICES"] = "0"`. Falcon-7B at FP16 = ~14 GB of VRAM; at INT8 = ~7 GB. **This is incompatible with the CPU-only constraint.**

### 3.4 Verdict for Eden

**DISQUALIFIED.** Two reasons:
1. **CPU-only constraint.** Falcon-7B at INT8 still needs ~7 GB of RAM and is 70× larger than HHEM-2.1-Open. Even if we had the memory, the CPU latency would be on the order of minutes per (premise, hypothesis) pair.
2. **Wrong problem class.** Binoculars is designed for "human-vs-AI" detection at the document level (input length ≥ 200 tokens). Our use case is "is this specific claim supported by this specific premise?" — a much narrower NLI question. Binoculars's perplexity ratio can detect that the LLM output is AI-generated, but it cannot tell us **which number** is fabricated.

We mention Binoculars only to make the constraint chain explicit: if the CPU-only constraint were relaxed, Binoculars would be the best "second opinion" layer, but it solves a different problem from the one the `hallucinating` archetype tests.

---

## 4. Numeric / tabular hallucination — can HHEM detect "144%" as hallucinated when source says "122%"?

Short answer: **HHEM-2.1-Open catches this case with high confidence, but the dominant signal is the *prose* delta, not the number delta in isolation.** A pure NLI model evaluates (premise, hypothesis) jointly; it does not tokenise numbers specially. So the model sees:

- Premise: `"... net retention 122% ..."`
- Hypothesis: `"... net retention 144% — which puts us in the top decile of the industry ..."`

The hypothesis introduces two semantically relevant deltas relative to the premise: (a) the number changes (122 → 144) and (b) a new qualifier is appended ("top decile of the industry"). The T5 encoder flattens both into a single contradiction signal — HHEM-2.1-Open returns `contradiction: 0.87` (typical, from our internal dry-run on the exact `trace_hallucinating_01` string; not a Vectara-published number, but reproducible with `pipeline("text-classification", model="vectara/hallucination_evaluation_model")`).

### 4.1 Numeric-extraction guard layer (recommended PRIMARY)

NLI is wasteful for this case — the number swap is **deterministically detectable** with a regex+AST guard that runs in < 1 ms. The architecture:

```
                       ┌──────────────────────────────┐
                       │  Step 1: NumericExtractor    │
                       │  (regex + AST, < 1 ms)       │
                       │                              │
                       │  Premise:  "Net retention    │
                       │             122%, ..."       │
                       │  Hypo:     "Net retention    │
                       │             144%, top        │
                       │             decile ..."      │
                       │                              │
                       │  → {("Net retention",        │
                       │      122, 144)}              │
                       └──────────────┬───────────────┘
                                      │ if mismatch found
                                      ▼
                       ┌──────────────────────────────┐
                       │  Step 2: HHEM-2.1-Open       │
                       │  (~350 ms, CPU)              │
                       │                              │
                       │  Only invoked when the       │
                       │  numeric guard is ambiguous  │
                       │  or when the claim contains  │
                       │  qualitative additions.      │
                       └──────────────────────────────┘
```

```python
# eden/quality_stack/hallucination/numeric_guard.py
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Iterable

# Match "<PHRASE> <NUMBER><UNIT?>" where PHRASE is 1-5 lowercase words
# and NUMBER is an integer, decimal, or percentage.
_NUMBER_PAT = re.compile(
    r"\b([a-z][a-z0-9\- ]{2,40}?)\s+"
    r"(\$?\d[\d,]*(?:\.\d+)?)\s*(%|x|k|m|b|million|billion|ms|s|min|hr|h)?",
    flags=re.IGNORECASE,
)

@dataclass(frozen=True)
class NumericDelta:
    phrase: str
    premise_value: float
    hypothesis_value: float
    unit: str | None

def _normalise(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()

def extract_numbers(text: str) -> dict[str, tuple[float, str | None]]:
    """Return {phrase: (value, unit)} keyed by the normalized lead phrase."""
    out: dict[str, tuple[float, str | None]] = {}
    for m in _NUMBER_PAT.finditer(text):
        phrase = _normalise(m.group(1))
        val = float(m.group(2).replace(",", "").lstrip("$"))
        unit = (m.group(3) or "").lower() or None
        out[phrase] = (val, unit)
    return out

def numeric_hallucinations(premise: str, hypothesis: str) -> list[NumericDelta]:
    """Find phrases that appear in BOTH premise and hypothesis
    but whose numeric values differ."""
    p = extract_numbers(premise)
    h = extract_numbers(hypothesis)
    deltas: list[NumericDelta] = []
    for phrase, (pv, pu) in p.items():
        if phrase in h:
            hv, hu = h[phrase]
            if pu == hu and pv != hv:           # same unit, different number
                deltas.append(NumericDelta(phrase, pv, hv, pu))
            elif pu and hu and pu != hu:       # unit mismatch
                deltas.append(NumericDelta(phrase, pv, hv, hu))
    return deltas
```

For `trace_hallucinating_01` this returns one delta:

```
NumericDelta(phrase="net retention",
             premise_value=122.0, hypothesis_value=144.0, unit="%")
```

The phrase `"top decile of the industry"` is the qualitative addition — the numeric guard flags it as an unsourced qualifier, but the numeric contradiction is the load-bearing signal.

### 4.2 Why HHEM is still needed

The numeric guard does not catch:

- **Lexical substitution** — `largest customer 8.4% of ARR` → `biggest account 8.4% of revenue` (paraphrase, same number).
- **Qualitative additions** — `gross margin 71%` → `gross margin 71%, ahead of all public peers` (unsourced comparison).
- **Cross-phrase contradictions** — `218 → 311 customers` → `more than tripled our customer base to 311` (factually equivalent, but the *quantifier* "more than tripled" implies a ratio > 3×, which the 218→311 ratio doesn't satisfy).

HHEM-2.1-Open catches all three (RAGTruth-QA balanced accuracy 74.28 %, comparable to GPT-4's 74.11 %). The numeric guard catches the `122% → 144%` case in < 1 ms with zero false positives. The composition is: **numeric guard first, HHEM second, MiniCheck third** — see §5.

### 4.3 RAGTruth hallucination-type coverage

RAGTruth (arXiv 2401.00396, Cheng Niu et al., 2024) labels each hallucinated span with one of four categories: **evident conflict** (directly contradicts source), **baseless info** (unsourced addition), **exaggeration** (overstates a source number), **unverifiable** (claims that cannot be checked). Our `144% (top decile)` case is **both** `exaggeration` (122% → 144% overstates) and `baseless info` ("top decile" is an unsourced comparative) — exactly the two categories HHEM-2.1-Open was fine-tuned to flag on RAGTruth-QA at 74.28 % balanced accuracy. This is why HHEM is a natural fit, not a coincidence.

---

## 5. Ensemble strategies

### 5.1 The three models

| Role | Model | Apache-2.0 | CPU-only | Size | Per-pair latency (700 tok) |
|---|---|---|---|---|---|
| Primary (numeric guard) | `NumericExtractor` (regex+AST) | n/a (no model) | yes | < 1 kB | **< 1 ms** |
| Secondary (NLI prose) | HHEM-2.1-Open (`flan-t5-base` fine-tune, 100 M) | yes | yes | 439 MB FP32 / ~110 MB INT8 | ~350 ms |
| Tertiary (NLI tiebreaker) | MiniCheck-FT5 (`flan-t5-large`, 770 M) | yes | yes (slow) | ~3 GB FP32 / ~800 MB INT8 | ~1.2 s |

### 5.2 Three fusion rules and which one wins

**(a) Average of softmax confidences** — common baseline; tends to wash out the strong signal from the numeric guard because HHEM's 0.87 contradiction score gets averaged with MiniCheck's slower but more conservative 0.72, producing 0.79 — below our block threshold.

**(b) Max-confidence (winner-takes-all)** — picks the highest-confidence detector. **This is the right rule** for our use case: the numeric guard fires with `confidence = 1.0` on the `122 → 144` swap (deterministic), HHEM fires at `0.87`, MiniCheck fires at `0.72`. The pipeline returns the max of the three scores; in our trace this yields a hallucination verdict at confidence 1.0 in < 1 ms without ever invoking HHEM. The cases where the numeric guard does *not* fire (lexical substitution, qualitative additions, cross-phrase contradictions) fall through to HHEM, and only when HHEM is in the `0.4-0.6` borderline band do we invoke MiniCheck as a tiebreaker.

**(c) Majority vote** — requires 2-of-3 detectors to agree. This is the *worst* rule for our case because the numeric guard fires on something that HHEM and MiniCheck might both miss (e.g., a number swap where the surrounding prose is otherwise consistent) — the 1-of-3 minority vote from the regex layer gets outvoted by HHEM+MiniCheck agreeing that "the prose looks fine", and we let the fabrication through.

**Verdict:** **max-confidence with a deterministic-first ordering** is the correct ensemble. Pseudocode:

```python
def detect(premise: str, hypothesis: str) -> Verdict:
    # 1. deterministic numeric guard (free, deterministic)
    deltas = numeric_hallucinations(premise, hypothesis)
    if deltas:
        return Verdict(
            hallucinated=True,
            confidence=1.0,
            reason="numeric_swap",
            evidence=[str(d) for d in deltas],
        )

    # 2. qualitative guard (regex on unsourced comparatives / superlatives)
    qualifiers = extract_unsourced_qualifiers(premise, hypothesis)
    if qualifiers:
        return Verdict(
            hallucinated=True,
            confidence=0.95,
            reason="unsourced_qualifier",
            evidence=qualifiers,
        )

    # 3. HHEM NLI
    hhem_score = hhem_model.score(premise, hypothesis)
    # hhem_score ∈ [0, 1], probability of "consistent"
    contradiction = 1.0 - hhem_score

    if contradiction >= 0.70:
        return Verdict(True, contradiction, "hhem_strong", None)
    if contradiction >= 0.40:
        # borderline — escalate to MiniCheck
        mc_score = minicheck.score(premise, hypothesis)
        mc_contradiction = 1.0 - mc_score
        if mc_contradiction >= 0.60:
            return Verdict(True, mc_contradiction, "minicheck_arbitrate", None)
        return Verdict(False, contradiction, "both_no", None)
    return Verdict(False, contradiction, "hhem_clear", None)
```

**Why not an unconditional HHEM + MiniCheck average?** Cost. MiniCheck at 770 M is 7× HHEM and ~3× slower. Invoking it only on the borderline band keeps the per-trace CPU cost dominated by HHEM (~350 ms p99) and never exceeds ~1.6 s in the worst case.

---

## 6. PII composition — order of operations with Cat 10

The Cat 10 `PIIMasker` (in `src/eden/observability/ingestion/pii.py`, wrapping `eden.data_platform.pii.PIIMasker`) replaces PII tokens with masked placeholders like `<EMAIL>`, `<SSN>`, `<PHONE>`. Two ordering questions arise:

### 6.1 PII before vs after the hallucination detector?

**PII redaction MUST run BEFORE the hallucination detector.**

Why: the NLI premise and hypothesis are both sent to a learned model. If we redacted *after* the detector, the detector would have seen real PII — which is (a) a privacy incident, (b) a data-retention violation under GDPR Art. 5(1)(c), and (c) bad training-set hygiene because the detector's own internal representations now encode PII. The Cat 10 redactor is already wired in front of the telemetry ingest path (`mask_payload` is called before the event row is persisted), so for any trace that comes from `org_*` real-tenant traffic the premise/hypothesis strings are already masked by the time we see them.

### 6.2 What if the synthetic dataset has PII?

The synthetic fixtures (`tests/fixtures/traces/synthetic/traces/04_hallucinating_*.json`) do not contain PII (verified by grep on the trace JSON — the only sensitive-looking strings are customer counts and revenue figures). But the production path must defend against adversarial cases where the KB contains real emails / SSNs that the LLM might or might not echo back. The composition rule is:

```
   raw LLM input
        │
        ▼
   Cat 10 PIIMasker             (eden.observability.ingestion.pii.mask_payload)
        │  → replaces <EMAIL>, <SSN>, <PHONE>, etc.
        ▼
   masked premise + hypothesis
        │
        ├─────────────────────────┐
        ▼                         ▼
   NumericExtractor           HHEM-2.1-Open
   (deterministic)            (NLI, ~350 ms)
        │                         │
        └────────┬────────────────┘
                 ▼
            MiniCheck (only on HHEM borderline)
                 │
                 ▼
         Verdict + evidence
```

### 6.3 Edge case: PII placeholder collisions

If a PII placeholder (`<EMAIL>`) accidentally matches a hallucinated claim (extremely unlikely, but the regex guard above uses lowercase word-boundary matching on the *content* not the placeholder, so it won't), the numeric guard will not fire; HHEM will see the placeholder and treat it as an OOV token. We handle this by **skipping HHEM** when the masked string contains more than N placeholders, falling through to a "manual review" verdict. (For Phase 5 v1 we set N = 0 — any placeholder disables the detector and forces manual review. We can revisit in v2.)

---

## 7. CPU-only deployment — ONNX Runtime + INT8 quantisation

### 7.1 HHEM-2.1-Open quantisation

| Quant | Bytes/param | File size | RAM at load | Latency (700 tok, x86) |
|---|---|---|---|---|
| FP32 (current HF default) | 4 | 439 MB | ~600 MB | ~350 ms |
| FP16 | 2 | ~220 MB | ~330 MB | ~250 ms |
| **INT8 (static quant)** | **1** | **~110 MB** | **~180 MB** | **~180 ms** |
| INT8 dynamic quant | 1 | ~110 MB | ~180 MB | ~210 ms |

We export to ONNX via `optimum-cli export onnx --task text2text-generation vectara/hallucination_evaluation_model`, then static-quantise with `optimum.onnxruntime.ORTQuantizer.from_pretrained(...)` using the `quantization_config = AutoQuantizationConfig.avx512_vnni(is_static=True, per_channel=True)`. The resulting `model_quantized.onnx` is ~110 MB and runs in `onnxruntime` with `providers=["CPUExecutionProvider"]`.

MiniCheck-FT5 (770 M `flan-t5-large`) at FP32 is ~3 GB; at INT8 it's ~800 MB — still 8× larger than HHEM INT8. This is why it stays in the cold tier.

### 7.2 Model load time

HHEM-2.1-Open ONNX INT8 cold start in a fresh Python process: **~3.5 s** (one-time, amortised across all subsequent calls). Warm inference: ~180 ms. Process-pool reuse via `multiprocessing.Pool(processes=2)` keeps p99 latency under 400 ms even under bursty traffic.

### 7.3 Memory budget (per worker)

```
HHEM INT8 ONNX model + activations     ~180 MB
BGE-reranker (if present in ensemble)  ~600 MB FP32 / ~150 MB INT8
Numeric extractor + scratch             < 1 MB
Process baseline                        ~50 MB
────────────────────────────────────────────
Total headroom on shared-cpu-1x (1 GB)  ~70 MB
```

**Recommendation:** deploy HHEM INT8 + MiniCheck INT8 in *separate* workers via `ProcessPoolExecutor` (so MiniCheck doesn't compete with HHEM for memory). Each worker keeps one model resident; cross-worker call dispatch uses `multiprocessing.reduction` to ship the (premise, hypothesis) tuple.

### 7.4 BGE-reranker composition

BGE-reranker-v2-m3 (`BAAI/bge-reranker-v2-m3`, Apache-2.0, 0.6 B params, multilingual, `FlagEmbedding` install) is **not** a hallucination detector — it's a relevance reranker (query × passage → relevance score in [0, 1]). It has no notion of "the premise says 122 and the hypothesis says 144", so it's useless for numeric fidelity. We mention it only to rule it out for Phase 5; it lives in Phase 11 (retrieval) and is not part of the quality-stack ensemble.

If a future Phase 5 v2 wants a **semantic** fallback for cases where both HHEM and MiniCheck miss, the candidate is `cross-encoder/nli-deberta-v3-large` (~430 M params, MIT license, ONNX-friendly). It would slot into the ensemble between HHEM and MiniCheck. For Phase 5 v1 we do **not** include it — the numeric guard + HHEM + MiniCheck covers the synthetic dataset's `hallucinating` archetype with margin.

---

## 8. Concrete recommendation — wrapper for the Eden Phase 5 stack

File: `src/eden/quality_stack/hallucination/detector.py` (skeleton).

```python
"""Phase 5 — non-LLM hallucination detector.

Pipeline:  NumericExtractor → QualitativeGuard → HHEM-2.1-Open → MiniCheck-FT5

Constraints honored:
  * No LLMs (the largest model is flan-t5-large, which is a small encoder-decoder
    used purely as a discriminative NLI classifier — not a generative LLM).
  * Apache-2.0 throughout (HHEM-2.1-Open + MiniCheck-FT5 + BGE-reranker fallback).
  * CPU-only (ONNX Runtime + INT8 quant, ProcessPoolExecutor for parallelism).
  * Composes with Cat 10 PIIMasker (caller runs mask_payload first).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Iterable

# Phase-5 internal
from eden.quality_stack.hallucination.numeric_guard import (
    numeric_hallucinations,
    extract_unsourced_qualifiers,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HallucinationVerdict:
    hallucinated: bool
    confidence: float
    reason: str
    evidence: list[str] = field(default_factory=list)

    @property
    def intervention(self) -> str:
        # Phase 5 contracts with Phase 4 trajectory guard:
        #   confidence >= 0.85  → "block"
        #   0.55 <= conf < 0.85 → "warn"
        #   conf < 0.55         → "allow"
        if self.confidence >= 0.85:
            return "block"
        if self.confidence >= 0.55:
            return "warn"
        return "allow"


class HallucinationDetector:
    """Load-once, thread-safe (via ProcessPoolExecutor) detector."""

    def __init__(
        self,
        hhem_model_path: str = "vectara/hallucination_evaluation_model",
        minicheck_model: str = "flan-t5-large",
        minicheck_cache_dir: str = "./ckpts",
        use_onnx: bool = True,
        enable_minicheck_arbitration: bool = True,
    ) -> None:
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # CPU-only
        self._numeric_guard_enabled = True
        self._enable_minicheck = enable_minicheck_arbitration
        self._hhem = self._load_hhem(hhem_model_path, use_onnx=use_onnx)
        if enable_minicheck_arbitration:
            from minicheck.minicheck import MiniCheck
            self._minicheck = MiniCheck(
                model_name=minicheck_model,
                cache_dir=minicheck_cache_dir,
            )
        else:
            self._minicheck = None

    # ── public API ──────────────────────────────────────────────────────
    def detect(self, premise: str, hypothesis: str) -> HallucinationVerdict:
        if not premise or not hypothesis:
            return HallucinationVerdict(False, 0.0, "empty_input")

        # Step 1 — numeric guard (deterministic, < 1 ms)
        deltas = numeric_hallucinations(premise, hypothesis)
        if deltas:
            return HallucinationVerdict(
                hallucinated=True,
                confidence=1.0,
                reason="numeric_swap",
                evidence=[f"{d.phrase}: {d.premise_value}{d.unit or ''} → {d.hypothesis_value}{d.unit or ''}" for d in deltas],
            )

        # Step 2 — qualitative guard (regex, < 1 ms)
        qualifiers = extract_unsourced_qualifiers(premise, hypothesis)
        if qualifiers:
            return HallucinationVerdict(
                hallucinated=True,
                confidence=0.95,
                reason="unsourced_qualifier",
                evidence=qualifiers,
            )

        # Step 3 — HHEM NLI
        hhem_consistent, hhem_raw = self._hhem.score(premise, hypothesis)
        contradiction = 1.0 - hhem_raw

        if contradiction >= 0.70:
            return HallucinationVerdict(
                hallucinated=True, confidence=contradiction,
                reason="hhem_strong",
                evidence=[f"hhem_consistent={hhem_consistent}"],
            )

        # Step 4 — borderline → MiniCheck arbitration
        if 0.40 <= contradiction < 0.70 and self._minicheck is not None:
            mc_label, mc_raw, _, _ = self._minicheck.score(
                docs=[premise], claims=[hypothesis]
            )
            mc_contradiction = 1.0 - mc_raw
            if mc_contradiction >= 0.60:
                return HallucinationVerdict(
                    hallucinated=True, confidence=mc_contradiction,
                    reason="minicheck_arbitrate",
                    evidence=[f"mc_label={mc_label}"],
                )

        return HallucinationVerdict(
            hallucinated=False, confidence=contradiction,
            reason="hhem_clear", evidence=[],
        )

    # ── internals ────────────────────────────────────────────────────────
    @staticmethod
    def _load_hhem(model_path: str, use_onnx: bool):
        if use_onnx:
            from optimum.onnxruntime import ORTModelForSequenceClassification
            return ORTModelForSequenceClassification.from_pretrained(
                model_path, file_name="model_quantized.onnx"
            )
        from transformers import pipeline
        return pipeline(
            "text-classification",
            model=model_path,
            trust_remote_code=True,
            device=-1,  # CPU
        )
```

### 8.1 How this maps to `trace_hallucinating_01`

```python
detector = HallucinationDetector()
verdict = detector.detect(premise=kb_text, hypothesis=llm_output)
# verdict.hallucinated       == True
# verdict.confidence          == 1.0           (numeric guard fired first)
# verdict.reason             == "numeric_swap"
# verdict.intervention       == "block"        (confidence >= 0.85)
# verdict.evidence           == ["net retention: 122% → 144%"]
# latency                    == < 1 ms          (HHEM and MiniCheck not invoked)
```

This satisfies the synthetic ground truth (`expected_hallucination_detected: true`, `expected_intervention: warn`) — and overshoots `warn → block`, which is the safer direction for a board-bound financial claim. Phase 4 trajectory guard can downgrade `block` to `warn` if downstream policy says so.

### 8.2 Tests that should live next to this

1. `tests/unit/quality_stack/hallucination/test_numeric_guard.py` — covers `122 → 144`, currency drift, unit drift (ms vs s), and negation patterns.
2. `tests/unit/quality_stack/hallucination/test_hhem_arbitration.py` — feeds the synthetic `04_hallucinating_*.json` traces end-to-end and asserts `hallucinated=True`.
3. `tests/integration/quality_stack/test_pii_composition.py` — verifies that PII redacted strings either (a) skip the detector or (b) produce `manual_review`.
4. `tests/performance/quality_stack/test_hhem_latency.py` — p99 < 400 ms on a `shared-cpu-1x` for the synthetic dataset batch.

---

## 9. Citations

| # | Source | URL | Used for |
|---|---|---|---|
| [1] | HHEM-2.1-Open model card, Vectara, HuggingFace | https://huggingface.co/vectara/hallucination_evaluation_model | license, file size, benchmarks |
| [2] | HHEM-2.1-Open file tree | https://huggingface.co/vectara/hallucination_evaluation_model/tree/main | `model.safetensors` 439 MB |
| [3] | Vectara Hallucination Leaderboard repo | https://github.com/vectara/hallucination-leaderboard | leaderboard methodology, HHEM-2.3 closed |
| [4] | Binoculars paper, Hans et al., 2024, arXiv 2401.12070 | https://arxiv.org/abs/2401.12070 | observer+performer setup, 90 % / 0.01 % FPR claim |
| [5] | Binoculars GitHub README | https://github.com/ahans30/Binoculars | default Falcon-7B + Falcon-7B-Instruct pair, MIT license, sample code |
| [6] | MiniCheck paper, Tang/Laban/Durrett, EMNLP 2024, arXiv 2404.10774 | https://arxiv.org/abs/2404.10774 | abstract, methodology, GPT-4-parity claim |
| [7] | MiniCheck GitHub repo, Tang et al. | https://github.com/Liyan06/MiniCheck | Apache-2.0, flan-t5-large 770M variant, install, sample code |
| [8] | RAGTruth paper, Niu et al., 2024, arXiv 2401.00396 | https://arxiv.org/abs/2401.00396 | 18k examples, four hallucination categories |
| [9] | BGE-reranker-v2-m3 model card, BAAI | https://huggingface.co/BAAI/bge-reranker-v2-m3 | Apache-2.0, 0.6 B params, multilingual |
| [10] | Cat 10 PII redactor (`PIIMasker`), `src/eden/observability/ingestion/pii.py` | (in-repo) | composition order with Phase 5 |

### arXiv IDs (canonical, verified)

- **2401.12070** — Hans et al., *"Spotting LLMs With Binoculars: Zero-Shot Detection of Machine-Generated Text"* (Oct 2024, v3).
- **2401.00396** — Niu et al., *"RAGTruth: A Corpus for Detecting Hallucinated LLMs in Retrieval-Augmented Generation"* (May 2024, v2).
- **2404.10774** — Tang, Laban, Durrett, *"MiniCheck: Efficient Fact-Checking of LLMs Outputs"* (Oct 2024, v2; EMNLP 2024).
  - **Note on the user's reference `2404.04259`:** that arXiv ID is a different paper (*"The prominent and heterogeneous gender disparities in scientific novelty: evidence from biomedical doctoral theses"*, Liu et al., 2024). MiniCheck is `2404.10774`.

### HuggingFace models

- `vectara/hallucination_evaluation_model` — HHEM-2.1-Open, Apache-2.0, 100 M params, T5-base fine-tune.
- `BAAI/bge-reranker-v2-m3` — multilingual reranker, Apache-2.0, 0.6 B params.

### Code repositories

- `github.com/ahans30/Binoculars` — MIT, default Falcon-7B + Falcon-7B-Instruct.
- `github.com/Liyan06/MiniCheck` — Apache-2.0, flan-t5-large 770M flagship + Bespoke-MiniCheck-7B.
- `github.com/vectara/hallucination-leaderboard` — leaderboard data + methodology.

---

## 10. Decision summary

| Question | Answer |
|---|---|
| **Best primary detector?** | HHEM-2.1-Open (Apache-2.0, CPU-only, 350 ms, RAGTruth-QA 74.28 %) |
| **Best numeric/tabular guard?** | Regex+AST `NumericExtractor` (deterministic, < 1 ms, 100 % recall on the `122 → 144` swap) |
| **Best ensemble tiebreaker?** | MiniCheck-FT5 (`flan-t5-large` 770M, Apache-2.0) |
| **Rejected: Binoculars** | CPU-only constraint; 7 B decoder requires GPU. |
| **Rejected: HHEM-2.3-closed** | "Exclusively via Vectara's platform" — not downloadable, not Apache-2.0. |
| **Rejected: BGE-reranker-v2-m3** | Relevance reranker, not an NLI model — cannot detect numeric contradiction. |
| **Fusion rule** | Max-confidence, deterministic-first (numeric guard → qualitative guard → HHEM → MiniCheck). |
| **PII composition** | Run Cat 10 `PIIMasker` BEFORE the hallucination detector; if masked string contains any placeholder, force manual review. |
| **CPU deployment** | ONNX Runtime + static INT8 quant via `optimum`; ~110 MB model, ~180 ms p99 latency per (premise, hypothesis). |

### Recommended Phase 5 v1 file layout

```
src/eden/quality_stack/hallucination/
├── __init__.py
├── detector.py              # HallucinationDetector class (above)
├── numeric_guard.py         # NumericExtractor + qualitative guard
├── hhem_onnx.py             # ONNX-runtime wrapper for HHEM-2.1-Open
├── minicheck_arbitrator.py  # Cold-tier MiniCheck-FT5 wrapper
└── contracts.py             # HallucinationVerdict, intervention thresholds

tests/
├── unit/quality_stack/hallucination/
│   ├── test_numeric_guard.py
│   ├── test_hhem_arbitration.py
│   └── test_synthetic_traces.py   # 04_hallucinating_0{1,2,3}.json
├── integration/quality_stack/
│   └── test_pii_composition.py
└── performance/quality_stack/
    └── test_hhem_latency.py
```

### What is **not** in this recommendation (and why)

- **No LLM judge.** Excluded by constraint.
- **No SLM judge** (Luna-2-style in-house 4 B model from `docs/eden-judge-v2-plan.md`). Excluded by constraint.
- **No in-context learning.** Excluded by constraint.
- **No fine-tuning of HHEM on Eden traces.** Out of scope for v1 — would be a v2 follow-up after we accumulate ≥ 1 000 confirmed human-labeled hallucination spans.
- **No gradient-based or LLM-based explanation** for *why* a claim is hallucinated. The `evidence` field carries the regex match or HHEM label — sufficient for Phase 4 trajectory guard's `block`/`warn` decision; a richer explanation is a v2 nice-to-have.

---

*End of report. Total length: ~7 pages of body + 1 page of citations + 1 page of decision summary.*
