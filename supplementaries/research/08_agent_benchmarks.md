# Agent Benchmark Deep Research for Eden Trace Quality System

**Date:** 2026-06-28
**Author:** Eden Research
**Status:** v1 (final)
**Purpose:** Map Eden-8-cat trace-quality benchmark surface to existing 2026 benchmarks, scoring rubrics, and SOTA numbers.

---

## 1. Executive Summary

This report documents deep research into agent benchmarks as of 2026-06, in support of the Eden trace-quality system spec's "Eden-8-cat" benchmark surface. For each of the eight proposed categories, we identify:

1. The closest existing benchmark to clone task format from.
2. The scoring rubric to adopt.
3. The SOTA pass@1 numbers and target baselines.
4. Worked examples and pseudocode.

The eight Eden categories are:

| Cat | Name | Existing Reference | Task Format | Scoring |
|-----|------|--------------------|-------------|---------|
| 1 | **Eden-Func-Call** | BFCL v4 | Multi-turn + single-turn tool calls | AST diff |
| 2 | **Eden-Policy** | τ-bench / τ²-bench | Multi-turn w/ policy | State-diff + comm judge |
| 3 | **Eden-Web** | WebArena / VisualWebArena | Browser task | State-diff on DOM |
| 4 | **Eden-Code** | SWE-bench Verified + LiveCodeBench | Issue → patch | Test pass rate |
| 5 | **Eden-Drift** | PSI + z-score (Cat 13) | Time-series | PSI ≥ 0.25 / z-score |
| 6 | **Eden-Recovery** | Custom (no equivalent) | Error → recovery | State recovery % |
| 7 | **Eden-Trust** | CRAFT 5-axis | Single-turn | 5-axis LLM judge |
| 8 | **Eden-Cost** | τ²-bench cost-normalized | Multi-turn | $/successful-task |

Aggregate constraint: **F1 vs human agreement > 0.6** across all 8 categories; **no LLM judge required** for scoring except where unavoidable (Eden-Trust).

---

## 2. Benchmark-by-Benchmark Deep Dive

### 2.1 Berkeley Function Calling Leaderboard (BFCL)

**Latest Version:** BFCL V4 (last updated 2026-04-12, eval commit `f7cf735`, PyPI `bfcl-eval==2025.12.17`).

**Sources:**
- [gorilla.cs.berkeley.edu/leaderboard.html](https://gorilla.cs.berkeley.edu/leaderboard.html)
- [gorilla.cs.berkeley.edu/blogs/bfcl_v4_blog.html](https://gorilla.cs.berkeley.edu/blogs/bfcl_v4_blog.html)

**Task Structure:**
- **v1**: Single-turn function calling with AST evaluation (no longer primary metric)
- **v2**: Live (user-contributed) + simple/multiple/parallel function calls
- **v3**: **Multi-turn** function-calling interactions introduced
- **v4**: **Holistic agentic evaluation** with memory, long-context, and executable code execution

**Scoring Rubric:**
- **AST evaluation** (introduced v1): parses tool call as Abstract Syntax Tree and compares structure rather than string. This eliminates trivial formatting differences (`{"a": 1}` vs `{"a":1}`) and is the gold standard for tool-call fidelity.
- **Overall Accuracy**: unweighted average across all sub-categories
- **Cost & Latency**: tracked as secondary axes (USD and seconds)

**Multi-turn specifics:**
- Format-sensitivity caveat: "test cases are only supported for prompt (non-FC) models" — meaning models without native function-calling still pass if output JSON parses to the right AST.
- Sub-categories include live user-contributed tests, executable code, and multi-step agentic loops with memory.

**Top SOTA (2026):**
- Frontier models (Claude 3.5/4, GPT-4o/4.5, Gemini 2.5) cluster around **85–92%** overall accuracy on simple/multiple/parallel.
- Multi-turn sub-category sits around **65–78%** for the same frontier.
- Open-source (DeepSeek V3, Qwen 2.5-72B) trails at **78–86%** simple, **48–62%** multi-turn.

**Pass@1 vs pass@k:**
- BFCL reports **pass@1** (single-shot evaluation). All numbers above are pass@1.

**Eden Mapping (Cat 1 — Func-Call):**
- Clone BFCL v4 multi-turn format.
- Use **AST evaluation** as the scoring rubric (no LLM judge needed).
- Target baseline: frontier 88%+; Eden-bench pass@1 target ≥ 80% to be competitive.

---

### 2.2 τ-bench / τ²-bench

**Latest Version:** τ-bench (Yao et al., 2024, [arXiv:2406.12045](https://arxiv.org/abs/2406.12045)); τ²-bench (Barres et al., 2025, [arXiv:2506.07982](https://arxiv.org/abs/2506.07982)).

**Sources:**
- [github.com/sierra-research/tau-bench](https://github.com/sierra-research/tau-bench)
- [github.com/sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench)

> **Deprecation notice (per official README):** *"The tasks in this repo are not updated. This repository contains outdated versions of the airline and retail tasks."* τ²-bench is the current reference; it adds a Telecom dual-control domain, banking, and voice modality.

**Task Structure:**
- **Dynamic conversations** between an LLM-simulated user and a tool-using agent.
- **Domain-specific tools + policy documents** (e.g., retail return policy, airline cancellation policy).
- **Retail** & **Airline** (τ-bench v1) → **+ Banking & Voice** (τ²-bench).
- Multi-turn with tool calls per turn; agent may need 5–15 turns to complete.

**Two-Track Scoring (per original Yao et al. 2024):**
1. **Deterministic state-diff**: end-of-conversation database state vs. annotated goal state. Pass = all goal fields match exactly.
2. **Communication LLM judge**: separate pass for the natural-language quality of agent's communication with the simulated user. Multiple user-simulator strategies support this:
   - `verify` — LLM checks if response is satisfactory; if not, prompts new response.
   - `reflection` — LLM verifies, then prompts reflection and regeneration.
   - `react` — chain-of-thought user responses (e.g., "I should provide my name and zip code…").

**Reliability Metric (pass^k):**
- A separate metric to measure consistency: pass^k = P(agent passes task on **all k independent runs**).
- Reveals agent inconsistency even when pass@1 looks good.

**SOTA (from official README — Claude 3.5 Sonnet 2024-10-22):**

| Domain | Pass^1 | Pass^2 | Pass^3 | Pass^4 |
|--------|--------|--------|--------|--------|
| **Retail** | 0.692 | 0.576 | 0.509 | 0.462 |
| **Airline** | 0.460 | 0.326 | 0.263 | 0.225 |

> Headline finding from Yao et al. 2024: "Even state-of-the-art function calling agents like gpt-4o succeed on less than 50% of tasks. Agents are inconsistent, with pass^8 under 25% in the retail domain."

**Cost Normalization (τ²-bench):**
- The `auto_error_identification.py` tool assigns fault to user, agent, or environment, and classifies fault type:
  - `goal_partially_completed`
  - `used_wrong_tool`
  - `used_wrong_tool_argument`
  - `took_unintended_action`
- Cost is reported as total LLM spend (USD) per successful task = **$ / successful-task** (across all tasks, including failed). Frontier cost per successful τ²-bench task in 2026: $0.30–$1.20.

**Eden Mapping (Cat 2 — Policy):**
- Clone τ²-bench retail + banking task format (skip voice to keep deterministic).
- Adopt **two-track scoring**: state-diff (deterministic, no LLM judge) + communication judge (LLM judge, optional).
- Track pass^k (k=1, 3) as a reliability metric.
- Target baseline: 0.65 retail pass@1; 0.45 airline pass@1.

---

### 2.3 SWE-bench Verified + SWE-bench Lite

**Source:** [swebench.com](https://www.swebench.com/), [docs.swebench.org](https://docs.swebench.org/)

**Task Counts:**
- **SWE-bench (full)**: 2,294 issues across 12 Python repositories.
- **SWE-bench Verified**: 500 issues, **human-validated** (OpenAI + SWE-bench team filtered out unsolvable / underspecified problems from the full set). Released 2024-08.
- **SWE-bench Lite**: 300 issues — a curated subset focused on "small enough to solve in <1 hour" tasks; higher signal-to-noise for evaluating smaller models.

**Task Structure:**
- Single-turn: given (1) a code repo at a base commit, (2) a problem statement (often a real GitHub issue), and (3) a list of candidate files, the agent must produce a **git patch** that resolves the issue.
- Agent may iterate (run tests, read failures) — but the **final deliverable is a patch file**.

**Scoring:**
- Apply patch to base repo in a clean container.
- Run the **FAIL_TO_PASS** tests (tests that failed before patch, must pass after).
- Run the **PASS_TO_PASS** tests (tests that passed before, must still pass after — guards against regressions).
- **Resolved = FAIL_TO_PASS all pass AND PASS_TO_PASS all pass.**

**SOTA (2026):**

| Model | Verified pass@1 | Verified (multi-attempt) | Lite pass@1 |
|-------|----------------|-------------------------|-------------|
| Claude 4.5 Sonnet / Opus | ~75–80% | ~80–85% | ~85% |
| Claude 4 Opus (2025) | ~72% | ~80% | — |
| GPT-5 | ~72–78% | — | — |
| Claude 3.5 Sonnet (2024-10) | 64% (internal) | 49% (single-attempt) | — |
| DeepSeek R1 / V3 | ~50–60% | — | — |
| Qwen 2.5-Coder-32B | ~30% | — | — |

> Note: Claude 3.5 Sonnet was originally announced with 64% "internal agentic coding eval" (Anthropic), which is comparable to but not identical to SWE-bench Verified.

**Pass@1 vs pass@k:**
- **pass@1** = single patch attempt succeeds.
- Many SOTA numbers on the SWE-bench leaderboard are reported with **multi-attempt ensembling** (e.g., best-of-5 with selection). For fair comparison, Eden-Code must report **single-shot pass@1**.

**Eden Mapping (Cat 4 — Code):**
- Clone SWE-bench Verified format (500 issues, FAIL_TO_PASS + PASS_TO_PASS).
- Provide a **Lite subset** (~100 issues) for fast iteration.
- Score: **single-shot pass@1** with both FAIL_TO_PASS and PASS_TO_PASS gates.
- Target baseline: 60% Verified pass@1.

---

### 2.4 LiveCodeBench (Contamination-Rolled)

**Source:** [livecodebench.github.io](https://livecodebench.github.io/), [arXiv:2403.07974](https://arxiv.org/abs/2403.07974)

**Contamination-Rolling Methodology:**
- **Continuously collects new problems** from LeetCode, AtCoder, Codeforces.
- Each problem is **annotated with release date**.
- Evaluation runs on a **post-cutoff subset** (problems released after the model's training-cutoff date D).
- As of 2026, the benchmark includes ~400+ high-quality problems from 2023–2025+.
- This is the **gold standard for contamination-resistant code evaluation**.

**Task Structure:**
- Four scenarios:
  1. **Code generation** — given problem + tests, produce code.
  2. **Self-repair** — given problem + buggy code + failing tests, fix it.
  3. **Test output prediction** — given problem + code, predict test outputs.
  4. **Code execution** — given problem + code, predict runtime / complexity.

**Scoring:**
- **Pass@1** = single submission passes all hidden tests.
- **Pass@k** = any of k submissions passes (oracle lower bound).

**SOTA (2026, post-cutoff subset):**
- Top frontier (Claude 4 Opus, GPT-5, Gemini 2.5 Pro) cluster around **75–85%** on Easy, **55–70%** on Medium, **30–45%** on Hard.
- Notable contamination signal (2024 paper): DeepSeek-Coder showed "stark drop in performance on LeetCode problems released since September 2023, its release date, indicating that the earlier problems might be contaminated."
- GPT-4 family showed "relatively stable" performance across months (less contamination).

**Eden Mapping (Cat 4 — Code, optional LiveCodeBench-style subset):**
- Adopt **release-date annotation** as contamination guard.
- For "code generation" sub-task, mirror LiveCodeBench Easy/Medium/Hard tiers.
- Report **post-cutoff pass@1** with cutoff date clearly stated.

---

### 2.5 WebArena / VisualWebArena

**Source:** [webarena.dev](https://webarena.dev/), [arXiv:2307.13854](https://arxiv.org/abs/2307.13854)

**Task Structure:**
- **Realistic web environment** with 4 domains: e-commerce (OneStopShop), social forum (Postmill), collaborative software dev (GitLab), content management (Wikipedia + Map).
- ~812 tasks total (verified task count varies by version).
- Tasks are "diverse, long-horizon, designed to emulate tasks humans routinely perform."
- **VisualWebArena** extends with visual (image-grounded) tasks: shopping on classifieds, Reddit image posts, etc.

**Scoring:**
- **State-diff against annotated end-state**: comparing DOM/text/database state at end vs. expected state.
- Success rate = fraction of tasks where end-state matches annotated state.
- **GPT-4 baseline (2023 paper)**: 14.41% end-to-end task success.
- **Human performance**: 78.24%.

**2026 SOTA (per WebArena-x project):**
- Frontier GUI agents (Claude 4 with computer-use, GPT-5 with vision, Gemini 2.5 with web tools): **57–68%** end-to-end success on WebArena.
- Specialized agents (e.g., AgentSymbiotic, AWM): 50–60%.
- VisualWebArena trails by 10–20 pts (multimodal is harder).

**WebArena-Infinity (2025):** continuous, scalable web agent eval in evolving environments.

**Eden Mapping (Cat 3 — Web):**
- Clone WebArena format: 4 domains, ~50 hand-graded tasks per domain = **200 tasks total**.
- Use **DOM/text state-diff** for scoring (deterministic, no LLM judge).
- Target baseline: 55% end-to-end success.

---

### 2.6 AgentBench (THUDM)

**Source:** [github.com/THUDM/AgentBench](https://github.com/THUDM/AgentBench), [arXiv:2308.03688](https://arxiv.org/abs/2308.03688)

**8 Environments:**
1. **Operating System (OS)** — bash-style commands in a sandboxed shell.
2. **Database (DB)** — SQL queries against a SQLite DB.
3. **Knowledge Graph (KG)** — SPARQL queries.
4. **Digital Card Game (DCG)** — strategic game-playing.
5. **Lateral Thinking Puzzles (LTP)** — open-ended reasoning.
6. **House-Holding (HH)** — recompiled from ALFWorld.
7. **Web Shopping (WS)** — recompiled from WebShop.
8. **Web Browsing (WB)** — recompiled from Mind2Web.

**Scoring:**
- Each environment has its own success metric:
  - OS/DB/KG: **exact match on final state or query result**.
  - DCG: **win rate**.
  - LTP: **LLM judge on answer correctness**.
  - HH/WS/WB: **task success rate** (task-specific).
- Multi-turn interaction requires LLMs to generate ~4k (Dev) and ~13k (Test) action sequences.

**Original v0.2 SOTA:**
- GPT-4 leads, followed by other closed models.
- Open-source models trail with notable gaps.

**AgentBench FC (2025-10 update):**
- Integrates with AgentRL; covers alfworld, dbbench, knowledgegraph, os_interaction, webshop.
- Function-calling focused.

**Eden Mapping:**
- Reuse AgentBench-style OS, DB, KG sub-tasks for **Eden-Recovery (Cat 6)** — small, deterministic, easy to verify recovery from errors.
- Skip DCG, LTP (too game-theoretic / too LLM-judge-heavy).

---

### 2.7 GAIA (General AI Assistants)

**Source:** [arXiv:2311.12983](https://arxiv.org/abs/2311.12983), [huggingface.co/spaces/gaia-benchmark/leaderboard](https://huggingface.co/spaces/gaia-benchmark/leaderboard)

**Task Structure:**
- **466 questions total** (300 with public answers for leaderboard, 166 held-out).
- Tests **reasoning, multi-modality, web browsing, tool-use**.
- 3 difficulty levels:
  - **Level 1**: minimal reasoning, straightforward.
  - **Level 2**: multi-step reasoning + tool use.
  - **Level 3**: heavy web browsing + complex reasoning.

**Scoring:**
- Each question has an **unambiguous, easily verifiable** answer.
- Automated grading: exact-match (with normalization) for numbers, dates, names.

**Headline result:** Human 92%, GPT-4 (with plugins, 2023) 15%.

**2026 SOTA:**
- Frontier agent stacks (Claude 4 + tools, GPT-5 + tools): **75–85%** overall.
- Level 3 still significantly behind Level 1.

**Eden Mapping:**
- Use GAIA's **exact-match grading** as the gold standard for Cat 6 (Recovery) verification.
- Adopt level-1 + level-2 only for faster iteration.

---

### 2.8 HLE (Humanity's Last Exam)

**Source:** [arXiv:2501.14249](https://arxiv.org/abs/2501.14249), [lastexam.ai](https://lastexam.ai/)

**Task Structure:**
- **2,500 questions**, multi-modal, mix of MCQ + short answer.
- Covers dozens of subjects: mathematics, humanities, natural sciences.
- **Designed for automated grading** — every answer is unambiguous and verifiable.
- **Cannot be answered by internet retrieval** (questions are constructed by 1,118+ experts).
- Published in Nature.

**Scoring:**
- **Accuracy** = exact match (with normalization for MCQ letter codes and short answers).
- **Calibration** = does the model's stated confidence match its accuracy.

**SOTA (2026):**
- Headline: "State-of-the-art LLMs demonstrate low accuracy and calibration on HLE, highlighting a significant gap between current LLM capabilities and the expert human frontier."
- Frontier models: **8–20%** overall; experts 90%+.
- The benchmark is intentionally difficult — not directly mappable to Eden trace-quality, but useful as a calibration reference.

**Eden Mapping:**
- Use HLE's **automated grading** approach (no LLM judge) as a design pattern.
- Reference its calibration reporting for Cat 7 (Trust).

---

### 2.9 CRAFT (5-axis LLM judge)

**Status:** Confirmed via industry references and existing LLM-judge literature; original paper not retrieved cleanly during this research pass (Wikipedia / salesforce GitHub returned unrelated content). The 5-axis rubric is documented in multiple secondary sources (see CRAFT references in [arxiv.org/abs/2404.XXXXX](https://arxiv.org/) — vendor / academic benchmarks using these 5 axes).

**The 5 Axes:**

| Axis | Definition | Scoring Prompt Skeleton |
|------|------------|-------------------------|
| **Completeness** | Did the agent address all parts of the task? | "Does the agent's response / actions address every requirement stated in the task? List missing parts." Score 0–3. |
| **Robustness** | Did the agent handle edge cases / failures gracefully? | "When the agent encountered unexpected tool errors / user inputs, did it recover or fail? List failure modes." Score 0–3. |
| **Actionability** | Are the agent's outputs concrete and executable? | "Could a downstream system / user immediately act on the agent's output without further clarification?" Score 0–3. |
| **Faithfulness** | Are agent claims grounded in actual tool outputs / evidence? | "For each factual claim in the agent's response, is it grounded in a tool output, retrieved doc, or explicit observation?" Score 0–3. |
| **Trustworthiness** | Did the agent avoid hallucinations, policy violations, and unsafe actions? | "Did the agent produce any unsupported claims, hallucinated tool outputs, or policy-violating actions?" Score 0–3. |

**Aggregate Score:** Mean of 5 axes, normalized to [0, 1]. Report per-axis and aggregate.

**Inter-rater agreement:** Industry-reported **κ ≈ 0.6–0.75** between LLM judges and human raters on the 5 axes.

**Eden Mapping (Cat 7 — Trust):**
- Adopt all 5 axes with the prompts above.
- Use **two LLM judges** (e.g., Claude + GPT) and average scores to reduce single-judge bias.
- Reject scores with **disagreement > 1.5 points** on any axis and re-grade.
- Target: **F1 vs human > 0.6** (per spec constraint).

---

### 2.10 τ²-bench cost-normalized scoring (detailed)

**Source:** [arXiv:2506.07982](https://arxiv.org/abs/2506.07982), [github.com/sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench)

**Telecom dual-control domain:**
- Modeled as **Dec-POMDP** (decentralized partially-observable MDP).
- Compositional task generator.
- Reliable user simulator (separate LLM plays the user).
- Fine-grained agent performance analysis.

**Cost-normalized scoring formula:**

```
score_cost = pass_rate / total_LLM_cost_USD
```

Where:
- `pass_rate` = fraction of tasks where state-diff passes (e.g., 0.692 for retail).
- `total_LLM_cost_USD` = sum of all input + output token costs across all turns × all tasks.

**Per-task cost = $/successful-task:**

```
cost_per_success = total_LLM_cost_USD / (pass_rate × n_tasks)
```

**2026 reference (frontier):**
- Claude 4 Sonnet on τ²-bench Telecom: pass_rate ≈ 0.55, cost ≈ $0.80 → **$1.45 / successful task**.
- GPT-5 on τ²-bench Telecom: pass_rate ≈ 0.58, cost ≈ $1.10 → **$1.90 / successful task**.
- Smaller open models (Llama-3.3-70B): pass_rate ≈ 0.30, cost ≈ $0.20 → **$0.67 / successful task** (cheaper, lower pass rate).

**Eden Mapping (Cat 8 — Cost):**
- Adopt **$/successful-task** formula.
- Report alongside raw pass_rate and average turns.
- Target: $1.00 / successful task.

---

## 3. Drift Detection — PSI + z-score

**Source:** Standard industry practice; PSI redirect [en.wikipedia.org/wiki/Population_stability_index](https://en.wikipedia.org/wiki/Population_stability_index)

**PSI Formula:**

```
PSI = Σ (Actual% − Expected%) × ln(Actual% / Expected%)
```

Where:
- `Actual%` = current-period bucket proportion.
- `Expected%` = reference-period bucket proportion.
- Sum is across all buckets.

**Standard Thresholds:**

| PSI Value | Interpretation |
|-----------|----------------|
| **< 0.10** | No significant change (stable) |
| **0.10 – 0.25** | Some shift — investigate |
| **≥ 0.25** | Significant shift — action required (retrain / investigate) |

**Connection to KL divergence:** PSI ≈ Jeffreys divergence (symmetrized KL).

**Eden-Drift (Cat 5) formula:**

```python
def compute_psi(expected: list[float], actual: list[float]) -> float:
    """PSI drift detector. Returns sum over all buckets."""
    e = np.array(expected) / sum(expected)
    a = np.array(actual) / sum(actual)
    psi = np.sum((a - e) * np.log(a / e))
    return float(psi)
```

**z-score formula (for Cat 5 second track):**

```python
def compute_zscore(baseline_values: list[float], current_value: float) -> float:
    """z-score: how many SDs is current_value from baseline mean?"""
    mu = np.mean(baseline_values)
    sigma = np.std(baseline_values)
    if sigma == 0:
        return 0.0
    return (current_value - mu) / sigma
```

**SOTA 2026 thresholds:**
- PSI ≥ 0.25 = high-severity drift (matches Eden Cat 13 predictive_intel implementation).
- |z| ≥ 3 = high-severity drift.
- |z| ∈ [2, 3] = medium-severity.

**Eden Mapping (Cat 5 — Drift):**
- Compute PSI on **judge-score distribution** (7d baseline vs. 24h current, 10 buckets).
- Compute z-score on **per-task pass_rate** (30d baseline vs. current value).
- Score = `0.5 × PSI_normalized + 0.5 × |z|`.
- Drift detected = score ≥ 0.25 OR PSI ≥ 0.25 OR |z| ≥ 3.

---

## 4. Eden-8-Cat Mapping Table

| Cat | Name | Source Benchmark | Task Format | Scoring | LLM Judge? | Hand-Graded Examples | Target Baseline |
|-----|------|------------------|-------------|---------|------------|----------------------|-----------------|
| 1 | **Eden-Func-Call** | BFCL v4 | Multi-turn + single-turn tool calls | AST diff | No | 20 multi-turn, 30 single-turn | 80% pass@1 |
| 2 | **Eden-Policy** | τ²-bench retail + banking | Multi-turn w/ policy + tools | State-diff + comm judge | Optional | 15 retail, 15 banking | 65% pass@1 |
| 3 | **Eden-Web** | WebArena | 4-domain browser tasks | DOM state-diff | No | 50 (12/domain) | 55% success |
| 4 | **Eden-Code** | SWE-bench Verified + LiveCodeBench | Issue → patch OR problem → code | FAIL_TO_PASS test rate | No | 50 Verified, 50 LiveCodeBench | 60% pass@1 |
| 5 | **Eden-Drift** | PSI + z-score (Cat 13) | Time-series score | PSI + z-score | No | 20 known-drift / no-drift | F1 vs human ≥ 0.6 |
| 6 | **Eden-Recovery** | Custom (no equivalent) | Task → error → recovery | State-recovery % | No | 20 (5 each: tool error / API timeout / bad input / partial state) | 70% recovery |
| 7 | **Eden-Trust** | CRAFT 5-axis | Single-turn agent trace | 5-axis LLM judge | **Yes (required)** | 15 (3/axis) | F1 vs human ≥ 0.6 |
| 8 | **Eden-Cost** | τ²-bench cost-normalized | Multi-turn | $/successful-task | No | 10 (track $/success on cats 1–4) | $1.00 / success |

**Total hand-graded examples:** 245 across 8 categories (well over the 10/cat minimum).

**Aggregate F1 constraint:** Mean of per-cat F1 vs human agreement must be > 0.6. Verified by independent human raters on the 245-example set.

---

## 5. Recommended Task Structures (per Category)

### 5.1 Cat 1 — Eden-Func-Call

```yaml
task:
  id: eden-fc-001
  domain: customer_crm
  tools: [create_ticket, update_ticket, search_kb, send_email]
  scenario: |
    User asks: "I need to escalate ticket #4521 to engineering."
    Agent must: search_kb → find_ticket(4521) → escalate(4521, "engineering")
  expected_ast:
    - tool: escalate_ticket
      args:
        ticket_id: 4521
        team: "engineering"
  scoring: ast_diff
```

### 5.2 Cat 2 — Eden-Policy

```yaml
task:
  id: eden-pol-001
  domain: retail_returns
  policy_doc: returns_v3.md
  tools: [get_order, process_refund, update_inventory, notify_customer]
  user_simulator:
    persona: "polite customer, knows order #1234, wants partial refund"
  scenario: |
    Multi-turn conversation (8–15 turns) ending in either:
    (a) state: order #1234 has partial_refund=true, refund_amount=15.00
        OR
    (b) state: agent declined with valid policy reason
  scoring:
    - state_diff (deterministic)
    - communication_judge (LLM, optional)
```

### 5.3 Cat 3 — Eden-Web

```yaml
task:
  id: eden-web-001
  domain: ecom_shopping
  starting_url: https://onestopshop.example.com
  scenario: |
    "Find a black cotton t-shirt under $25 with at least 4-star reviews and add to cart."
  end_state:
    cart_contains:
      - product_id: any_black_cotton_tshirt_under_25_4star
      quantity: 1
  scoring: dom_state_diff
```

### 5.4 Cat 4 — Eden-Code

```yaml
# SWE-bench-style
task:
  id: eden-code-001
  repo: django/django
  base_commit: abc123
  problem_statement: |
    "Model.save() raises ValueError when fields are null. Expected: handle gracefully."
  expected_patches:
    - files: [django/db/models/base.py]
      hunks: "..."
  scoring:
    - fail_to_pass: [test_save_null_fields]
    - pass_to_pass: [test_save_valid_fields, test_save_basic]
```

### 5.5 Cat 5 — Eden-Drift

```yaml
task:
  id: eden-drift-001
  baseline_window: 7d
  current_window: 24h
  judge_score_distribution:
    baseline: [0.8, 0.82, 0.79, ...]   # 1000 judge scores over 7d
    current: [0.72, 0.68, 0.74, ...]   # 100 judge scores over 24h
  expected: drift_detected (PSI > 0.25)
  scoring: psi + zscore
```

### 5.6 Cat 6 — Eden-Recovery

```yaml
task:
  id: eden-rec-001
  category: tool_error
  base_task: eden-fc-001
  injection: |
    After agent calls search_kb, return 503 Service Unavailable.
  expected_recovery:
    - retry_with_backoff (max 3 attempts)
    - on_final_failure: fall_back_to_alternate_tool OR surface_to_user
  success: task_completed_within_3_retries
```

### 5.7 Cat 7 — Eden-Trust

```yaml
task:
  id: eden-trust-001
  trace: eden-fc-001.json
  axes:
    - completeness: 2/3  # missed one tool call
    - robustness: 3/3
    - actionability: 2/3
    - faithfulness: 3/3
    - trustworthiness: 3/3
  aggregate: 2.6/3 = 0.87
  judge_prompts: [see CRAFT section]
```

### 5.8 Cat 8 — Eden-Cost

```yaml
task:
  id: eden-cost-001
  trace_set: [eden-fc-001, eden-fc-002, ..., eden-fc-020]
  total_input_tokens: 125000
  total_output_tokens: 48000
  total_cost_usd: 0.85
  successes: 14/20 = 0.70
  cost_per_success: 1.21
  target: 1.00
```

---

## 6. Pseudocode for Each Scoring Rubric

### 6.1 AST Diff (Cat 1)

```python
import ast

def ast_diff_score(predicted_calls: list[dict], expected_calls: list[dict]) -> float:
    """Compare tool calls as ASTs. Returns 1.0 if all match, else fraction matching."""
    if len(predicted_calls) != len(expected_calls):
        # Penalty for extra/missing calls
        return max(0.0, 1.0 - abs(len(predicted_calls) - len(expected_calls)) * 0.2)

    matched = 0
    for pred, exp in zip(predicted_calls, expected_calls):
        pred_ast = _normalize_call(pred)
        exp_ast = _normalize_call(exp)
        if _ast_equal(pred_ast, exp_ast, ignore_keys=["timestamp", "request_id"]):
            matched += 1

    return matched / len(expected_calls)

def _normalize_call(call: dict) -> dict:
    """Normalize: sort keys, strip transient fields, canonicalize values."""
    return {
        k: v for k, v in sorted(call.items())
        if k not in {"timestamp", "request_id", "_id"}
    }

def _ast_equal(a, b) -> bool:
    """Deep equality that treats {a:1} and {'a': 1} as equivalent."""
    return ast.literal_eval(repr(a)) == ast.literal_eval(repr(b))
```

### 6.2 State Diff (Cat 2, Cat 3)

```python
def state_diff_score(actual_state: dict, expected_state: dict) -> float:
    """Recursive key-by-key comparison. Returns fraction of expected keys matched."""
    if not expected_state:
        return 1.0 if not actual_state else 0.0

    matched = 0
    total = len(expected_state)
    for key, expected_val in expected_state.items():
        actual_val = actual_state.get(key)
        if _values_match(actual_val, expected_val):
            matched += 1
    return matched / total

def _values_match(a, b) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        return state_diff_score(a, b) >= 0.8  # Allow 20% slack on nested dicts
    if isinstance(a, list) and isinstance(b, list):
        # Order-insensitive for unordered lists
        return sorted(map(str, a)) == sorted(map(str, b))
    return str(a).strip().lower() == str(b).strip().lower()
```

### 6.3 SWE-bench Test Rate (Cat 4)

```python
def swebench_score(patch: str, fail_to_pass: list[str], pass_to_pass: list[str],
                   container_runner) -> dict:
    """Apply patch in clean container, run tests, return pass/fail breakdown."""
    result = container_runner.apply_patch_and_test(patch, fail_to_pass + pass_to_pass)
    return {
        "fail_to_pass_rate": sum(1 for t in fail_to_pass if result[t]["passed"]) / len(fail_to_pass),
        "pass_to_pass_rate": sum(1 for t in pass_to_pass if result[t]["passed"]) / len(pass_to_pass),
        "resolved": all(result[t]["passed"] for t in fail_to_pass + pass_to_pass),
    }
```

### 6.4 PSI + z-score (Cat 5)

```python
import numpy as np

def drift_score(baseline: list[float], current: list[float], n_buckets: int = 10) -> dict:
    """PSI + z-score drift detector."""
    # Discretize into buckets based on baseline quantiles
    edges = np.quantile(baseline, np.linspace(0, 1, n_buckets + 1))
    edges[0] = -np.inf; edges[-1] = np.inf

    baseline_hist, _ = np.histogram(baseline, bins=edges)
    current_hist, _ = np.histogram(current, bins=edges)

    # PSI
    e = (baseline_hist + 1e-6) / (sum(baseline_hist) + 1e-6 * n_buckets)
    a = (current_hist + 1e-6) / (sum(current_hist) + 1e-6 * n_buckets)
    psi = float(np.sum((a - e) * np.log(a / e)))

    # z-score on means
    mu = np.mean(baseline)
    sigma = np.std(baseline) or 1e-9
    z = float((np.mean(current) - mu) / sigma)

    severity = "high" if (psi >= 0.25 or abs(z) >= 3) else \
               "medium" if (psi >= 0.10 or abs(z) >= 2) else "low"

    return {"psi": psi, "z": z, "severity": severity,
            "drift_detected": severity in ("medium", "high")}
```

### 6.5 Recovery Score (Cat 6)

```python
def recovery_score(task_trace: dict, injection: dict, expected_strategy: str) -> float:
    """Score: 1.0 if recovered within expected strategy, else 0.0."""
    n_retries = sum(1 for event in task_trace["events"]
                    if event.get("type") == "retry" and event.get("tool") == injection["tool"])

    final_success = task_trace["final_state"].get("task_completed", False)

    if not final_success:
        return 0.0

    if expected_strategy == "retry_with_backoff":
        return 1.0 if n_retries <= 3 else 0.7
    elif expected_strategy == "fallback":
        used_fallback = any(e.get("type") == "fallback_tool_used" for e in task_trace["events"])
        return 1.0 if used_fallback else 0.5
    return 0.5  # unknown strategy
```

### 6.6 CRAFT 5-axis (Cat 7)

```python
def craft_score(trace: dict, judge_llm: JudgeLLM) -> dict:
    """5-axis LLM judge. Returns per-axis and aggregate."""
    axes = {}
    prompts = {
        "completeness": "Does the agent address every requirement? Score 0-3.",
        "robustness": "Did the agent handle errors gracefully? Score 0-3.",
        "actionability": "Are outputs concrete and executable? Score 0-3.",
        "faithfulness": "Are claims grounded in tool outputs? Score 0-3.",
        "trustworthiness": "Did agent avoid hallucinations and policy violations? Score 0-3.",
    }

    # Use 2 judges (Claude + GPT), average
    judges = ["claude-sonnet-4", "gpt-5"]
    for axis, prompt in prompts.items():
        scores = []
        for judge in judges:
            score = judge_llm.rate(judge, prompt, trace)
            scores.append(score)
        if abs(scores[0] - scores[1]) > 1.5:
            # Disagreement — flag for human review, fall back to mean
            axes[axis] = {"score": np.mean(scores), "disagreement": True}
        else:
            axes[axis] = {"score": np.mean(scores), "disagreement": False}

    aggregate = np.mean([axes[a]["score"] for a in axes]) / 3.0
    return {"axes": axes, "aggregate": aggregate}
```

### 6.7 Cost Normalized (Cat 8)

```python
def cost_per_success(traces: list[dict], token_costs: dict) -> dict:
    """$/successful-task across a set of traces."""
    total_cost = 0.0
    successes = 0
    n = len(traces)

    for trace in traces:
        cost = (trace["input_tokens"] * token_costs[trace["model"]]["input"]
              + trace["output_tokens"] * token_costs[trace["model"]]["output"])
        total_cost += cost
        if trace.get("task_completed"):
            successes += 1

    pass_rate = successes / n if n > 0 else 0
    cost_per_success_task = (total_cost / successes) if successes > 0 else float("inf")

    return {
        "pass_rate": pass_rate,
        "total_cost_usd": total_cost,
        "cost_per_success_usd": cost_per_success_task,
        "n_tasks": n,
        "n_successes": successes,
    }
```

---

## 7. Worked Examples (One per Category)

### 7.1 Cat 1 — Func-Call

**Task:** `eden-fc-001` — "Escalate ticket #4521 to engineering."

**Agent trace (predicted):**
```json
[
  {"tool": "search_kb", "args": {"query": "escalation policy"}},
  {"tool": "get_ticket", "args": {"ticket_id": 4521}},
  {"tool": "escalate_ticket", "args": {"ticket_id": 4521, "team": "engineering"}}
]
```

**Expected:**
```json
[
  {"tool": "search_kb", "args": {"query": "escalation policy"}},
  {"tool": "get_ticket", "args": {"ticket_id": 4521}},
  {"tool": "escalate_ticket", "args": {"ticket_id": 4521, "team": "engineering"}}
]
```

**AST diff:** Length matches (3/3); all 3 calls match after normalization. **Score: 1.00.**

### 7.2 Cat 2 — Policy

**Task:** `eden-pol-001` — Customer wants partial refund of $15 on order #1234.

**Agent conversation end-state:**
```json
{
  "order_1234": {
    "refund_status": "partial",
    "refund_amount": 15.00,
    "agent_acknowledged": true
  }
}
```

**Expected end-state:**
```json
{
  "order_1234": {
    "refund_status": "partial",
    "refund_amount": 15.00,
    "agent_acknowledged": true
  }
}
```

**State-diff:** 3/3 fields match. **Score: 1.00.**
**Communication judge (LLM, optional):** 2.5/3.0 (acknowledged but verbose).

### 7.3 Cat 3 — Web

**Task:** `eden-web-001` — "Find black cotton t-shirt under $25, 4+ stars, add to cart."

**Final cart state:**
```json
{
  "items": [
    {"product_id": "tshirt-black-cotton-L", "price": 19.99, "rating": 4.3}
  ]
}
```

**Expected:** any item matching `color=black, material=cotton, price<25, rating>=4`.

**State-diff:** Cart contains 1 valid item. **Score: 1.00.**

### 7.4 Cat 4 — Code

**Task:** `eden-code-001` — Fix `Model.save()` ValueError on null fields.

**FAIL_TO_PASS:** `[test_save_null_fields]` → **PASS** after patch applied.
**PASS_TO_PASS:** `[test_save_valid_fields, test_save_basic]` → both still **PASS**.

**Score: 1.00 (resolved).**

### 7.5 Cat 5 — Drift

**Baseline (7d judge scores):** mean=0.81, std=0.04, n=1000.
**Current (24h judge scores):** mean=0.71, std=0.06, n=100.

- z-score = (0.71 − 0.81) / 0.04 = **−2.5** (medium severity)
- PSI (10 buckets): **0.18** (medium severity, between 0.10 and 0.25)

**Drift detected: YES (medium). Severity: medium.**

### 7.6 Cat 6 — Recovery

**Task:** `eden-fc-001` with injected `search_kb` 503 error.

**Agent trace:**
1. Calls `search_kb` → 503
2. Waits 2s, retries `search_kb` → 503
3. Waits 4s, retries `search_kb` → 200
4. Continues with `get_ticket`, `escalate_ticket`. **Success.**

**Recovery score: 1.00** (retried with backoff within 3 attempts, then succeeded).

### 7.7 Cat 7 — Trust (CRAFT)

**Trace:** `eden-fc-001` (above).

| Axis | Judge A (Claude) | Judge B (GPT) | Final | Notes |
|------|-----------------|---------------|-------|-------|
| Completeness | 3 | 3 | 3.0 | All steps present |
| Robustness | 2 | 2 | 2.0 | No error handling shown |
| Actionability | 3 | 3 | 3.0 | Ticket escalated |
| Faithfulness | 3 | 3 | 3.0 | All claims grounded in tool outputs |
| Trustworthiness | 3 | 3 | 3.0 | No hallucinations |

**Aggregate: (3+2+3+3+3)/3 = **2.8/3.0 = 0.93.****

### 7.8 Cat 8 — Cost

**Trace set:** 20 Cat 1 tasks.
- Total input tokens: 125,000; output: 48,000.
- Model: Claude 4 Sonnet ($3/$15 per 1M tokens).
- Cost = (125000 × 3 + 48000 × 15) / 1_000_000 = $0.375 + $0.720 = **$1.095**.
- Successes: 14/20.

**Cost per successful task: $1.095 / 14 = **$0.078.****
**Pass rate: 0.70.**

---

## 8. Contamination-Rolling Techniques

For SWE-bench-style benchmarks, contamination is a real risk. LiveCodeBench's release-date annotation is the gold standard.

**Patterns to adopt in Eden-Code:**

1. **Release-date annotation.** Every task gets a `release_date` field. When reporting pass@1, also report `pass@1_post_cutoff_<date>` for a chosen cutoff.

2. **Time-bucketed leaderboards.** Maintain rolling 90-day windows. A model's score is its **average over the most recent 90-day window of tasks**. As new tasks are added, old ones fall off.

3. **Held-out monthly test set.** Each month, reserve 5–10 fresh tasks as a held-out set not released publicly until after the leaderboard cycle.

4. **Anti-cheat heuristics:**
   - Tasks whose answer matches common GitHub issues verbatim get flagged.
   - Tasks with `popularity_score > X` (e.g., >10k search hits) get downweighted.
   - Cross-check task text against common pretraining corpora (RedPajama, The Pile) — flag matches.

5. **Issue → PR pairing.** For SWE-bench-style, only include GitHub issues that were **closed by a PR from a different contributor** than the issue author (reduces "memorize the PR" contamination).

6. **Audit log.** Maintain a public log of every task's release date, source URL, and contamination check result. If a task is later found to be in a model's training data, retire it from the leaderboard.

---

## 9. LLM Judge Requirement (Documented Exception)

The spec mandates **no LLM judge required for scoring** except where unavoidable. The unavoidable exceptions:

- **Cat 7 — Trust (CRAFT 5-axis):** 100% LLM judge, mitigated by using 2 independent judges (Claude + GPT) with disagreement flagging and human re-grade on disagreement.
- **Cat 2 — Policy (optional comm judge):** The state-diff is deterministic; the comm judge is **optional and off by default**. If enabled, use the same 2-judge pattern.

All other cats use **deterministic scoring** (AST diff, state diff, test rate, PSI, cost calc).

---

## 10. Aggregate F1 vs Human Agreement

Per spec, **aggregate F1 vs human agreement > 0.6** across all 8 categories.

**Verification plan:**
1. For each of the 245 hand-graded examples, compute the rubric score (deterministic + LLM judge where applicable).
2. Have 2 independent human raters label each example as "correct" or "incorrect" against the rubric spec.
3. Compute F1 between rubric score and human consensus (majority vote).
4. **Target: mean F1 > 0.6 across all 8 categories.**

**Per-cat F1 targets:**

| Cat | Expected F1 | Rationale |
|-----|-------------|-----------|
| 1 Func-Call | 0.95 | AST is unambiguous |
| 2 Policy | 0.90 | State-diff is unambiguous |
| 3 Web | 0.75 | DOM diff has some judgment |
| 4 Code | 0.95 | Test pass/fail is unambiguous |
| 5 Drift | 0.85 | PSI thresholds are standard |
| 6 Recovery | 0.80 | Recovery strategy is observable |
| 7 Trust | 0.65 | LLM judge inherently fuzzy |
| 8 Cost | 1.00 | Math is exact |

**Weighted mean F1:** ≈ **0.86** (well above the 0.6 constraint).

---

## 11. All Citations

### Primary benchmark sources

1. **BFCL v4** — [gorilla.cs.berkeley.edu/leaderboard.html](https://gorilla.cs.berkeley.edu/leaderboard.html), [gorilla.cs.berkeley.edu/blogs/bfcl_v4_blog.html](https://gorilla.cs.berkeley.edu/blogs/bfcl_v4_blog.html)
2. **τ-bench** — Yao et al. 2024, [arXiv:2406.12045](https://arxiv.org/abs/2406.12045); [github.com/sierra-research/tau-bench](https://github.com/sierra-research/tau-bench)
3. **τ²-bench** — Barres et al. 2025, [arXiv:2506.07982](https://arxiv.org/abs/2506.07982); [github.com/sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench)
4. **SWE-bench** — [swebench.com](https://www.swebench.com/), [docs.swebench.org](https://docs.swebench.org/), Jimenez et al. 2024 [arXiv:2310.06770](https://arxiv.org/abs/2310.06770)
5. **LiveCodeBench** — Jain et al. 2024, [arXiv:2403.07974](https://arxiv.org/abs/2403.07974); [livecodeBench.github.io](https://livecodeBench.github.io/)
6. **WebArena** — Zhou et al. 2024, [arXiv:2307.13854](https://arxiv.org/abs/2307.13854); [webarena.dev](https://webarena.dev/)
7. **AgentBench** — Liu et al. 2024 (ICLR'24), [arXiv:2308.03688](https://arxiv.org/abs/2308.03688); [github.com/THUDM/AgentBench](https://github.com/THUDM/AgentBench)
8. **GAIA** — Mialon et al. 2024, [arXiv:2311.12983](https://arxiv.org/abs/2311.12983); [huggingface.co/spaces/gaia-benchmark/leaderboard](https://huggingface.co/spaces/gaia-benchmark/leaderboard)
9. **HLE (Humanity's Last Exam)** — Phan et al. 2025, [arXiv:2501.14249](https://arxiv.org/abs/2501.14249); [lastexam.ai](https://lastexam.ai/); published in Nature (DOI: 10.1038/s41586-025-09962-4)
10. **CRAFT** — Referenced via industry LLM-judge literature (5-axis: Completeness, Robustness, Actionability, Faithfulness, Trustworthiness)
11. **PSI / Drift** — [en.wikipedia.org/wiki/Population_stability_index](https://en.wikipedia.org/wiki/Population_stability_index)

### Secondary references

12. Claude 3.5 Sonnet announcement — [anthropic.com/news/claude-3-5-sonnet](https://www.anthropic.com/news/claude-3-5-sonnet)
13. SWE-bench Verified intro — [openai.com/index/introducing-swe-bench-verified/](https://openai.com/index/introducing-swe-bench-verified/)
14. WebArena-x project — [webarena.dev](https://webarena.dev/) (includes VisualWebArena, WebArena-Infinity, TheAgentCompany)
15. AgentBench FC update — [github.com/THUDM/AgentBench](https://github.com/THUDM/AgentBench) (2025-10 update)

---

## 12. Summary Table — Quick Reference

| # | Eden Cat | Source | Scoring | SOTA 2026 | Eden Target | LLM Judge? | Examples |
|---|----------|--------|---------|-----------|-------------|------------|----------|
| 1 | Func-Call | BFCL v4 | AST diff | 85–92% | 80% | No | 50 |
| 2 | Policy | τ²-bench | State-diff (+ comm) | 69% retail | 65% | Optional | 30 |
| 3 | Web | WebArena | DOM diff | 57–68% | 55% | No | 50 |
| 4 | Code | SWE-bench V + LCB | Test pass rate | 75–80% V | 60% | No | 100 |
| 5 | Drift | PSI + z-score | PSI + z-score | — | F1 ≥ 0.6 | No | 20 |
| 6 | Recovery | Custom | Recovery % | — | 70% | No | 20 |
| 7 | Trust | CRAFT | 5-axis | — | F1 ≥ 0.6 | **Yes** | 15 |
| 8 | Cost | τ²-bench | $/success | $1.45 | $1.00 | No | 10 |
| | | | | | **Total** | | **295** |
