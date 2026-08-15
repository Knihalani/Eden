# Competitor Landscape Map — Tracing, Evals, Cost, Alerting, Datasets, RBAC (2026)

Scope note: this is the broad landscape map only. Evals/datasets, playgrounds,
alerting/on-call, cost/governance, security/RBAC, annotation, SDK-DX, gateway,
session-analytics, guardrails, and the continuous-improvement loop are each
covered in depth by sibling docs in this same directory
(`02-evals-datasets.md`, `04-alerting-oncall.md`, `06-cost-governance.md`,
`07-security-compliance.md`, etc.) — rows below that overlap those are kept
short and pointed at the deep-dive doc. **New in this pass:** Lemma's
"Artifacts" and "Issue Extraction" capabilities now have their own
standalone spec-depth docs, `15-artifacts-behavior-record.md` and
`16-issue-extraction-online-evals.md` — this file cross-links to them rather
than duplicating their depth.

**Trigger for this pass (third revision)**: (a) a corrected research
finding — Lemma's "Artifacts" and "Issue Extraction" are confirmed real,
live, named product surfaces (see Headline finding — pass 2 looked in the
wrong place and wrongly flagged them as unverified); (b) fresh 2026 sourcing
added for LangSmith, Braintrust, Langfuse, and Arize Phoenix/AX beyond the
first two passes' citations (pricing pages, a changelog entry, GitHub
issues, G2/Reddit complaints); (c) six competitors newly researched and
added — Weights & Biases Weave, Comet Opik, Confident AI/DeepEval, AgentOps,
Coval, Patronus AI (all confirmed active in 2026 via direct web research;
Log10 was checked and found to have pivoted away from this market — see
below); (d) a deeper codebase re-pass surfaced six eden capability areas not
in either prior draft — `topics/`, `time_travel/forker.py`, `redteam/`,
`predictive/drift.py`, `change_impact/`, `apm_depth/step_judges.py` — each
now has a matrix row.

## Headline finding (revised — corrects pass 2)

**Pass 2 was wrong to flag "Artifacts" and "Issue Extraction" as unverified
Lemma product names.** Pass 2 searched Lemma's marketing site, blog, and
changelog and reasonably concluded the terms weren't there. This pass
searched one layer deeper — Lemma's own machine-readable API index at
`docs.uselemma.ai/llms.txt` and the individual OpenAPI-derived reference
pages it links to — and found both terms are real, live, and precisely
matched to the brief's description. **"Artifacts" is a defined API tag**
covering a versioned "**learn-agent artifact**" object (`knowledge_md` +
`mermaid` per project+agent, regeneratable via an async workflow the
client polls for) — a materially closer match to the brief's "persistent,
evolving record of how an agent is *supposed* to behave" than anything on
the public marketing site describes. **"Issue Extraction" is literal, live
API terminology**, not marketing copy, naming the automated
per-thread-failure-surfacing pipeline; the underlying `list_issues` schema
also reveals a multi-lane (`lanes_fired`: `A`/`B`/`C`) detection ensemble
reconciled by a `validation.status` step with a human `confirmation_verdict`
tracked as first-class data — a materially more sophisticated architecture
than either prior pass credited Lemma with, and the closest documented
competitor analog found so far to eden's own precision-gated
shadow-detector lifecycle (`soft_issue_review.py:333-478` — see the matrix
row below). These endpoints require `bearerAuth` to actually call, but the
*reference documentation describing them* is public and unauthenticated at
`docs.uselemma.ai` — this is publicly verifiable product surface, not
private-beta hearsay. Full endpoint-level and schema-level detail (the six
Artifacts endpoints, the full `list_issues` field list) is intentionally
not repeated here — it lives in `15-artifacts-behavior-record.md`
(Artifacts) and `16-issue-extraction-online-evals.md` (Issue Extraction),
consistent with this file's own scope note; this section carries only the
fact-check and the competitive framing. Sources:
[docs.uselemma.ai/llms.txt](https://docs.uselemma.ai/llms.txt),
[docs.uselemma.ai/api-reference/artifacts/get-learn-agent-artifact-version](https://docs.uselemma.ai/api-reference/artifacts/get-learn-agent-artifact-version.md),
[docs.uselemma.ai/api-reference/issues/list-issues](https://docs.uselemma.ai/api-reference/issues/list-issues.md),
[docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries](https://docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries.md).

**The LangSmith Engine comparison from pass 2 still stands and is
sharpened, not superseded**, by one new codebase finding: eden is not as
GitHub-blind as pass 2 implied. eden *does* have a working GitHub write
client — `GitHubOAuthClient.create_check_run` and
`.create_pr_comment` (`src/eden/integrations/github/oauth.py:558,581`) — used
by a different feature, `change_impact/preview.py:426-477`
(`post_github_check_and_comment`, N04 pre-merge impact preview: posts a
Check Run + PR comment when a PR touches agent config). So eden can already
*write to a PR* today — it just doesn't do so from the issue-resolution
path. `IssuePromptEvolver.evolve_from_issue`
(`agents/evolution/components.py`) still only creates an internal
prompt-version candidate, confirmed again this pass — but "eden has no
GitHub write capability" would now be an inaccurate framing; the accurate
framing is "eden's GitHub write path exists but isn't wired to the
issue→fix loop that Lemma and LangSmith Engine both automate end-to-end."

## Competitor summaries (web research, 2026)

**Lemma (YC F25)** — 2-person SF team (Jerry Zhang, Cole Gawin, ex-Tandem/
Chipstack), "production monitoring for AI agents" catching semantic
failures traditional error monitoring misses. Marketing-site-confirmed
capabilities: **Issues** (audits every trace against agent instructions,
groups recurring failures — worked example: a support agent that invents
placeholder customer IDs, flagged across 66% of runs, none tripping
standard error monitoring since every call returned success — 23 fabricated
lookups, 15 orphaned tickets with `customerId: "unknown"`, 7 escalations
routed to nonexistent tickets); **Live Alerts** (Slack); **Lemma MCP**
(`get_incident`/`get_traces` into a coding agent, which can then open a PR);
**Metrics** (auto-created online eval after a fix ships). **Now also
confirmed via API docs** (see Headline finding): a versioned **Artifacts**
knowledge-object system (`learn-agent artifact`: `knowledge_md` + `mermaid`
per project/agent, regeneratable, polled by version) and literal
**"issue extraction"** pipeline terminology with a multi-lane
(`lanes_fired: A/B/C`) validation + human-confirm architecture. Integrations:
Vercel AI SDK, OpenAI Agents, LangGraph, Anthropic, plus ingest from
Langfuse and Arize Phoenix. SOC 2 Type II, AES-256/TLS. No public pricing
page found. Sources:
[uselemma.ai](https://www.uselemma.ai/),
[docs.uselemma.ai](https://docs.uselemma.ai/),
[docs.uselemma.ai/llms.txt](https://docs.uselemma.ai/llms.txt) (full API
sitemap — the source of the Artifacts/Issue-Extraction fact-check),
[uselemma.ai/blog/introducing-lemma](https://www.uselemma.ai/blog/introducing-lemma),
[github.com/uselemma](https://github.com/uselemma) (org repos:
`lemma` — public SDKs/docs/agent skills, `archipelago` — "harness for
running and evaluating AI agents against RL environments",
`llm-cost-observability`), [x.com/uselemma_ai](https://x.com/uselemma_ai),
[ycombinator.com/companies/uselemma](https://www.ycombinator.com/companies/uselemma),
[fondo.com/blog/lemmaf25-launches](https://fondo.com/blog/lemmaf25-launches).

**LangSmith** — full "agent operations stack" on SmithDB (purpose-built
trace store). 2026 flagship: **LangSmith Engine** (public beta, 2026-05-13)
— clusters failures into named issues, root-causes against the connected
repo, opens a GitHub PR with a fix + suggested online evaluator + offline
eval examples, runs an initial audit on connect then a 6-hour recurring
scan; org admins cap spend in LCU ($1.50/LCU) or USD. **New this pass —
pricing and backlash detail**: Developer plan is free (1 seat, 5k base
traces/mo); **Plus is $39/seat/mo** (10k base traces included); base traces
(14-day retention) run $2.50/1k, extended traces (400-day retention)
$5.00/1k — at 1M base traces/mo on one seat this runs **~$2,514/mo**, cited
by third-party comparisons as "roughly 25x more expensive than Langfuse at
scale." Confirmed **GitHub issues show LangSmith miscalculates cost for
Perplexity API calls**, undermining spend forecasting, and running an eval
on a historical base trace silently upgrades it to extended retention
(the $5.00/1k tier) — a frequently flagged billing "gotcha." Reddit
discussion (referenced by multiple 2026 pricing-comparison sites) points to
a visible user migration to self-hosted Langfuse after LangChain cut its
old free tier. As of **late July 2026**, LangSmith moved Email Support off
the Plus tier onto Enterprise-only (self-serve portal replaces it on Plus)
without changing the $39/seat sticker price. RBAC, SSO, self-hosting remain
Enterprise-gated. Sources:
[langchain.com/langsmith/observability](https://www.langchain.com/langsmith/observability),
[langchain.com/blog/introducing-langsmith-engine](https://www.langchain.com/blog/introducing-langsmith-engine),
[docs.langchain.com/langsmith/engine](https://docs.langchain.com/langsmith/engine),
[inference.net/content/langsmith-pricing](https://inference.net/content/langsmith-pricing/),
[morphllm.com/comparisons/langfuse-vs-langsmith](https://www.morphllm.com/comparisons/langfuse-vs-langsmith),
[costbench.com/langsmith](https://costbench.com/software/ai-observability/langsmith/).

**Langfuse** (MIT, ClickHouse-acquired Jan 2026) — hierarchical-span
tracing, LLM-judge + code-based evals, annotation queues, prompt management,
built-in playground, self-hostable; 2026 additions include agent-native
tooling (SKILL.md, CLI, MCP server). **New this pass — self-host friction,
sourced from Langfuse's own GitHub, not third-party review sites**: SDK v3
requires **self-hosted platform version ≥ 3.125.0** for full feature parity
— a real version-pinning tax for self-hosters upgrading the client without
also upgrading the server; model-based evaluation jobs in the Langfuse UI
are **public beta on Langfuse Cloud only** (not yet available self-hosted,
per Langfuse's own troubleshooting docs); self-hosters are advised to avoid
the newer `api.observations`/`api.metrics` namespaces and use legacy v1
endpoints until Observations v2/Metrics v2 ship for self-hosted deployments.
This is a concrete, sourced instance of the same gap Langfuse's own
"vs LangSmith" positioning page admits in the abstract (eval-depth and
CI/CD gating lag Braintrust) — self-hosters specifically are also a
release behind Cloud on evals. Sources:
[langfuse.com/resources/langsmith-alternative](https://langfuse.com/resources/engineering/langsmith-alternative),
[github.com/langfuse/langfuse/discussions/12926](https://github.com/orgs/langfuse/discussions/12926)
("Self hosted v4"), [langfuse.com/self-hosting/troubleshooting-and-faq](https://langfuse.com/self-hosting/troubleshooting-and-faq),
[github.com/langfuse/langfuse](https://github.com/langfuse/langfuse).

**Braintrust** — eval-first, Brainstore trace store. **Topics** (shipped
~2026-06-04, modeled on Anthropic's Clio) daily-classifies every production
trace on built-in + custom facets, writing labels back for 100%-of-traffic
filtering ("active observability"). **Loop** natural-language analysis
agent that also generates scorers/datasets/prompts. **New this pass —
pricing and changelog detail**: Braintrust **renamed its free plan to
"Starter" in March 2026** and switched billing to processed-data volume
(inputs/outputs/prompts/metadata/traces ingested); Topics usage is metered
*separately* with its own monthly credit — **$10/mo on Starter, $249/mo on
Pro** (2026 launch-promotion rate), custom on Enterprise — meaning the
headline "Topics runs on 100% of traffic" claim has a real, sourced dollar
ceiling on every tier below Enterprise. Live changelog
(`braintrust.dev/docs/changelog`) shows ongoing 2026 activity, e.g. service-
token creation via the API was re-enabled for org owners in a June 2026
entry. GitHub Action CI-gates merges on quality regression. Enterprise adds
custom RBAC, SAML SSO, HIPAA BAA, self-hosting. Sources:
[braintrust.dev/articles/agent-observability-complete-guide-2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026),
[braintrust.dev/docs/changelog](https://www.braintrust.dev/docs/changelog),
[braintrust.dev/articles/what-are-topics-in-braintrust-2026](https://www.braintrust.dev/articles/what-are-topics-in-braintrust-2026),
[braintrust.dev/blog/announcing-series-b](https://www.braintrust.dev/blog/announcing-series-b)
($80M raise).

**Arize Phoenix / AX** — free OTel/OpenInference-native OSS tracer
(Elastic License 2.0) plus commercial Arize AX (alerts, online evals, agent
copilots, RBAC, compliance). **New this pass — pricing/complaint detail**:
AX tiers are Free ($0, 25k spans/mo, 1GB, 15-day retention) / Pro ($50/mo,
50k spans/mo, 10GB, 30-day retention) / Enterprise (custom, **median buyer
reported paying ~$60,000/yr** per third-party pricing analysis, with no
published tier between $50/mo Pro and Enterprise). **G2 reviewer quote**:
"Pricing can sometimes be on the higher side, particularly if we are
tracing telemetry or logs... the costs can escalate due to unknown error
factors." A specific mechanism cited for cost surprise: **an agent run
emits 40–75 spans**, so span-metered billing climbs fast on agentic
(vs. single-call) workloads — a structurally different cost curve than
eden's own per-session/per-turn cost model (`sessions.py:153-171`). One
reviewer also flagged the **Arize AX pricing page itself returning HTTP
403**, echoing a broader "enterprise pricing is opaque" community
complaint. Sources:
[makerstack.co/reviews/arize-phoenix-review](https://makerstack.co/reviews/arize-phoenix-review/),
[laminar.sh/article/arize-phoenix-alternatives-2026](https://laminar.sh/article/arize-phoenix-alternatives-2026),
[cekura.ai/blogs/arize-ai-pricing](https://www.cekura.ai/blogs/arize-ai-pricing),
[costbench.com/arize-phoenix](https://costbench.com/software/ai-observability/arize-phoenix/).

### Extended landscape (pass 2 — kept, not re-verified this pass)

**Galileo**, **Datadog Agent Observability**, **Helicone** (Mintlify-
acquired, maintenance mode since March 2026), **PromptLayer** (market
consolidation: Humanloop wound down, Vellum pivoted away, PromptHub
winding down), **HoneyHive**, **Maxim AI**, **Traceloop/OpenLLMetry**,
**Fiddler AI/WhyLabs** — see the "Extended landscape spot-checks" table
below for the capability comparison; full paragraph writeups are unchanged
from pass 2 and are not repeated here to keep this pass focused on new
material. Sources unchanged from pass 2 (see Sources section).

### New competitors this pass (verified active in 2026)

**Weights & Biases Weave** — LLM observability layer on top of W&B's ML
platform (`@weave.op` auto-tracing, cost/latency capture, LLM-judge
scorers). Now one of four W&B product surfaces alongside Models
(experiment tracking/artifacts), Serverless Inference, and the core
platform — **W&B itself is CoreWeave-owned as of 2026**. Pricing: Free
(personal/academic), Teams ~$50/seat/mo, or a 2026-restructured Pro
($60/mo) + metered storage ($0.03/GB) + Weave ingestion ($0.10/MB) model
depending on source. Explicitly positioned by third-party comparisons as
lacking virtual keys, provider fallback, cost-aware routing, a runtime
guardrail layer, or a trace-driven prompt optimizer — narrower than eden on
the guardrails/optimization axis, but backed by W&B's existing ML-platform
distribution. Sources:
[wandb.ai LLM observability report](https://wandb.ai/onlineinference/genai-research/reports/LLM-observability-Enhancing-AI-systems-with-W-B-Weave--VmlldzoxMjY4MjMwNQ),
[braintrust.dev/articles/best-weights-and-biases-alternatives-2026](https://www.braintrust.dev/articles/best-weights-and-biases-alternatives-2026),
[usagepricing.com/blueprint/weights-biases](https://www.usagepricing.com/blueprint/weights-biases).

**Comet Opik** — fully Apache-2.0 open-source LLM eval/observability
platform (tracing, evals, LLM-judge, prompt management, a Prompt
Playground, and an **Agent Optimizer**), released 2024, **12,500+ GitHub
stars within 8-9 months**, and as of 2026 processing **40M+ traces/day**
across 150,000+ developers. **Comet was named in the 2026 Gartner Market
Guide for AI Evaluation and Observability Platforms** — a notable
credibility marker for an OSS-first entrant. Pricing: OSS self-hosted is
free; Opik Cloud has a free tier plus **Opik Pro Cloud at $19/mo**. Distinct
from eden in going further on true full-OSS licensing than Langfuse
(Langfuse gates some Enterprise features) while still shipping an
optimizer loop (Agent Optimizer) comparable in shape to eden's
prompt-evolution path. Sources:
[comet.com/site/products/opik](https://www.comet.com/site/products/opik/),
[baeseokjae.github.io/posts/comet-opik-review-2026](https://baeseokjae.github.io/posts/comet-opik-review-2026/).

**Confident AI / DeepEval** — DeepEval is the free, open-source "pytest for
LLMs" testing framework (metric-threshold pass/fail tests, CI/CD-native);
**Confident AI** is the commercial cloud layer built by the same team,
scoring production traces against 50+ quality metrics, tracking regressions
across prompt versions, quality-aware alerting, human annotation. Pricing
(sourced from Confident AI's own pricing page): **Free** (2 seats, 1
project, unlimited trace spans, 1 GB-month, 5 test runs/week, no card
required); paid-tier figures vary by source ($9.99/user/mo to $200/mo
reported across different aggregators — flagged here as a genuine
sourcing inconsistency, not resolved this pass); Team/Enterprise custom.
DeepEval-side judge cost is separately billed to the model provider
(~$2.50–$5.00 per 500 evals on GPT-4o, or $0 on local Llama 3.1 via
Ollama). Sources:
[confident-ai.com/pricing](https://www.confident-ai.com/pricing),
[confident-ai.com/knowledge-base/compare/best-llm-evaluation-tools](https://www.confident-ai.com/knowledge-base/compare/best-llm-evaluation-tools),
[aitestingguide.com/deepeval-review](https://aitestingguide.com/deepeval-review/).

**AgentOps** — local-first agent observability (passive hooks, privacy
scrubbing, live streaming), positioned for teams running agents in
sandboxed/air-gapped environments without code changes; strongest on
tracing/replay/cost/debugging rather than eval-dataset depth or annotation
queues. Pricing: **Free** (5,000 events), **Pro $40/mo** (unlimited events,
retention, export, RBAC), Enterprise (on-prem/self-hosted). Consistently
listed alongside LangSmith/Langfuse/Arize/Braintrust/Galileo/Datadog in
2026 "best agent observability tool" roundups — confirmed still actively
developed (unlike Helicone, which is in the same roundups but flagged
maintenance-mode). Sources:
[mlflow.org/articles/what-is-agent-observability-a-2026-developer-guide](https://mlflow.org/articles/what-is-agent-observability-a-2026-developer-guide/),
[arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/).

**Coval** — voice/chat-agent-specific simulation and evaluation platform
(not a general LLM-observability competitor — narrower, vertical focus).
**Raised a $28M Series A in June 2026** (led by Norwest; Base10, Twilio
Ventures, YC participating), $31M total raised, **60+ customers including
Zoom and Deepgram**. Simulates thousands of synthetic callers
pre-deployment (conflicting details, early hangups) via text/voice/
transcript/audio-driven scenario generation, then in production logs real
calls, evaluates against custom metrics, and feeds *failed production
calls back into the simulation test suite automatically* — a closed
production→test loop conceptually similar to eden's
`agent_issues.py` resolve→regression-case pipeline, but purpose-built for
voice/turn-taking failure modes (interruptions, latency-sensitive
barge-in, ASR/TTS error propagation) that eden's text-oriented pipeline
does not address. Coval's own research: teams in healthcare/fintech/QSR see
**first-week production success rates 20–30 points below pre-launch test
scores**. Relevant to eden only if/when eden or its customers ship voice
agents — flagged here as a category eden does not currently compete in.
Sources:
[prnewswire.com Coval Series A](https://www.prnewswire.com/news-releases/coval-raises-28-million-series-a-to-define-safety-and-reliability-for-autonomous-voice-agents-302808740.html),
[coval.dev/2026-voice-ai-report](https://www.coval.dev/2026-voice-ai-report),
[coval.ai/blog/voice-ai-agent-evaluation-guide](https://www.coval.ai/blog/voice-ai-agent-evaluation-guide/).

**Patronus AI** — evaluation/security platform built around proprietary
small models: **Lynx** (hallucination detection), **GLIDER** (rubric-based
scoring), and **Percival** (an agent debugger detecting **20+ agentic
failure modes** across four failure categories in production traces) — the
most directly comparable competitor product to eden's tool-call-misuse
classifier and shadow-detector lineup found in this entire research
program. **$50M Series B in June 2026** (Greenfield Partners; Notable
Capital, Lightspeed, **Datadog**, and Samsung participating — notable that
Datadog is both a competitor in this matrix and a Patronus investor),
revenue reported up **15x year-over-year**, $70M total raised. Late-2025/
2026 expansion into **Digital World Models / RL Environments / Generative
Simulators** for pre-deployment agent stress-testing — demand described by
TechCrunch as "nearly insatiable," customers reportedly including most
frontier AI labs. No published self-serve pricing found (`patronus.ai/
pricing` exists but dollar figures were not captured by any indexed
source in this pass — flagged as an evidence gap, not confirmed absence).
Sources:
[techcrunch.com/2026/06/25/patronus-ai-lands-50m](https://techcrunch.com/2026/06/25/patronus-ai-lands-50m-to-build-digital-worlds-that-stress-test-ai-agents/),
[patronus.ai/agents](https://www.patronus.ai/agents),
[galileo.ai/blog/best-ai-agent-evaluation-platforms](https://galileo.ai/blog/best-ai-agent-evaluation-platforms).

**Checked and excluded: Log10** — was an LLM observability/LLMOps tool
(one-line Python client, multi-provider logging), $7.2M seed (Quiet
Capital, TQ Ventures). **As of 2026 the company has pivoted its primary
product to "Everest," a life-sciences regulated-document-generation tool**
(CERs, 510(k), CSRs) for pharma/medtech/CRO workflows — the original
observability library still exists on GitHub with recent commits, but the
company's own site now leads with "Log10 – AI Accuracy. Delivered." /
Everest branding, not observability. Not included as an active 2026
observability competitor for that reason. Source:
[everest.log10.io](https://everest.log10.io/),
[log10.io/news/seed](https://www.log10.io/news/seed).

## Deep codebase re-pass — six eden capability areas not in prior drafts

Broadened the grep beyond the files pass 2 cited and found six modules
under `src/eden/` with no representation in either prior matrix draft.
None of these are covered by the sibling docs listed in the scope note
(they're not evals/datasets, alerting, cost, security, or the continuous-
improvement loop specifically), so they belong here.

- **`src/eden/topics/service.py` (F65 — "Topics / insights clustering
  service")** — a **direct structural analog to Braintrust's Topics**:
  `list_topics(org_id, facet)` reads a `topic_clusters` table keyed by
  `facet` (`task`/`sentiment`/`issues`/`custom`) with `share_pct`,
  `keywords`, `sample_count`, `representative_trace_ids`
  (`service.py:18-59`); `act_on_topic(..., action="dataset")` creates a
  dataset from a topic's representative traces via `DatasetHub`
  (`service.py:217-256`, an F53 bridge). **Important nuance**:
  `generate_topics` (`service.py:147-153`) does not run a fresh per-trace
  LLM classification pass across 100% of traffic the way Braintrust's
  Topics does — it calls the existing `patterns_clusterer.run_once()` and
  then `_sync_patterns_to_topics` mirrors the **top 50** `trace_patterns`
  rows (by `sample_count`) into `topic_clusters`
  (`service.py:156-212`). So eden *has* a topics-style faceted view, but it
  is derived from — not independent of — the existing pattern-clustering
  engine, and the `action="alert"` branch of `act_on_topic` is a stub that
  returns `{"status": "queued"}` without doing anything
  (`service.py:230-231`). Verdict: real capability, thinner than
  Braintrust's, worth a matrix row of its own rather than folding into the
  existing "incident clustering" row.
- **`src/eden/time_travel/forker.py` (Cat 20 — `TraceForker`)** — branches
  a *production trace* at a chosen step index into a new `fork_id` that
  replays steps `1..N-1` from cache (`cache_lookups` table) and
  re-executes `fork_at_step..N` live, optionally applying customer-supplied
  per-step `edits` (persisted as `edits_json` for reproducible replay) —
  including fork-of-fork lineage via `parent_fork_id`
  (`forker.py:52-124`). The module docstring is explicit about scope: v1.3
  does **not** clone `telemetry_events` rows — it's a lightweight metadata
  row over the existing cache + ingestion tables, with a v2 true-clone path
  noted as a follow-up (`forker.py:1-30`). No competitor in this matrix
  documents an equivalent "fork a specific real production trace at step N
  and re-run downstream with edits, hybrid cached+live" primitive — Maxim
  AI's pre-deployment simulation runs synthetic scenarios, not edited
  forks of real traces; eden's own `debugger/checkpoints.py` (cited in
  pass 2) replays a recorded trace as-is, without the fork/edit/lineage
  layer this module adds on top.
- **`src/eden/redteam/probes.py` (adversarial probe suite + `ProbeRunner`)**
  — 12 built-in, named adversarial probes: `stan_jailbreak`,
  `dude_jailbreak`, `dan_jailbreak`, `prefix_injection`,
  `refusal_suppression`, `indirect_injection`, `system_prompt_leak`,
  `markdown_injection`, `pii_extraction`, `training_data_probe`,
  `role_override`, `tool_amplification` (`probes.py:334-511`), each backed
  by a detector function (e.g. `_pii_detect`, `_system_prompt_leak_detect`,
  `_tool_amplification_detect`, `probes.py:143-320`). `ProbeRunner.run_probe`
  / `.run_suite` (`probes.py:574-635`) execute probes against a live agent,
  persist `ProbeFinding`s (`probes.py:636-657`), and can fire a drift alert
  on findings (`_fire_drift_alert`, `probes.py:658+`). This is genuinely new
  territory for this matrix: it's the closest eden analog found to
  Patronus AI's Percival (20+ agentic failure modes) and to general
  automated-red-teaming products, and it was not covered — or even
  grepped for — in either prior pass.
- **`src/eden/predictive/drift.py` (Cat 13 — `DriftDetector`)** — Population
  Stability Index (PSI) drift detection on two axes:
  `detect_output_drift` (judge scores, 7-day baseline vs. 24h current
  window, `drift.py:97-186`) and `detect_embedding_drift`
  (`drift.py:187-285`). Threshold convention: PSI < 0.1 no shift, 0.1–0.2
  warning, > 0.2 high (`_severity_for_psi`, `drift.py:286`). The module
  docstring explicitly frames this as **"Phoenix / Datadog parity"** and,
  refreshingly, self-admits a real limitation: embedding drift is computed
  by hashing `response_body` text into 64 buckets (`_hash_bucket`) rather
  than using a learned embedding model — "a *content-only* topic-drift
  proxy... a true production system would use a learned embedding model;
  the v1 ship uses a stable hash so the computation is O(1) and
  dependency-free" (`drift.py:1-38`). This directly narrows the "Missing"
  cell this matrix would otherwise assign eden against Arize
  Phoenix's real embedding-based drift/UMAP visualization — eden has a
  drift detector, but on its own documentation's admission, a materially
  cruder one than Phoenix's on the embedding axis (output-drift via judge
  scores is not similarly caveated and looks comparable).
- **`src/eden/change_impact/preview.py` (N04 — `ChangeDetector` +
  `ImpactPreviewOrchestrator`)** — detects agent-config diffs in a GitHub
  PR (`ChangeDetector`, `preview.py:75-99`), replays stratified production
  traces against the changed config via the F01 cached-prefix debugger,
  runs N01 regression evals (`ImpactPreviewOrchestrator`,
  `preview.py:100+`), then posts the result as a **GitHub Check Run +
  PR comment** via `post_github_check_and_comment`
  (`preview.py:426-477`), which calls `GitHubOAuthClient.create_check_run`
  and `.create_pr_comment` (`src/eden/integrations/github/oauth.py:558,581`)
  — skipping cleanly (`{"skipped": true, "reason": "github_not_configured"}`)
  when no GitHub App is connected. This is a real, working GitHub write
  path — see the Headline-finding correction above — and it is closer in
  *shape* to Braintrust's CI-gating GitHub Action (block/flag a PR based on
  eval results) than to LangSmith Engine/Lemma's fix-PR flow, but with a
  differentiator neither Braintrust nor pass-2's research surfaced for any
  competitor: it replays **actual stratified production traces** against
  the PR's diff, not just a static eval dataset.
- **`src/eden/apm_depth/step_judges.py` (Cat 22 — `StepJudgeStamper`)** —
  extends telemetry events with a `step_index` + `step_judges` field
  (stored in `telemetry_events.attributes` JSONB), exposing `stamp` (write
  per-step judge scores onto a span), `get_step_judges`, and
  `get_trace_steps` (list every step in order with its judge scores). The
  module docstring is explicit that this ship is **"stamping only"** — the
  actual per-step `JudgeRunner` wiring that would populate these scores
  automatically is called out as a v0.1 follow-up not yet built
  (`step_judges.py:1-22`). Comparable in shape to HoneyHive's per-step
  eval metrics and to Datadog's step-level attribution, but currently a
  storage/read primitive without the automatic per-step scoring loop wired
  up — a "Partial, self-admitted incomplete" cell, not a "Have."

## Primary feature × competitor × eden matrix

| Feature | Lemma | LangSmith | Braintrust | Langfuse | Arize Phoenix/AX | eden status | eden evidence |
|---|---|---|---|---|---|---|---|
| Span-level distributed tracing | Have — MCP-queryable traces, ingests from Langfuse/Phoenix too ([source](https://docs.uselemma.ai/)) | Have — SmithDB trace store, trajectory queries ([source](https://www.langchain.com/langsmith/observability)) | Have — Brainstore, 80x query claim ([source](https://www.braintrust.dev/articles/best-ai-observability-tools-2026)) | Have — hierarchical spans, OTel-native ([source](https://github.com/langfuse/langfuse)) | Have — OTel/OpenInference-based ([source](https://makerstack.co/reviews/arize-phoenix-review/)) | Have | `intelligence_rca.py:80-123` (`_build_causal_chain`); `intelligence_rca.py:126-156` (`/chain` endpoint) |
| Automatic RCA / causal-chain construction across a failing trace | Partial — "diagnoses root cause" per-issue, not a documented per-trace causal-chain object | Partial — Engine diagnoses root cause per-issue, not an explicit per-trace chain | Partial — Topics clusters by issue, not a causal chain per trace | Missing — no dedicated RCA engine found | Missing — no dedicated RCA engine found | Have | `intelligence_rca.py:38,52-65,80-156` (`RootCauseAnalyzer`, `root_causal_span_id` earliest-failure-wins) |
| Incident/failure clustering across traces (issue-level, event-triggered) | Have — "Issues" ([source](https://www.uselemma.ai/)), now confirmed multi-lane w/ validation+confirm ([source](https://docs.uselemma.ai/api-reference/issues/list-issues.md)) | Have — Engine clusters into named issues w/ severity+evidence | Have — Topics (daily classification, 100% of traffic) | Missing | Partial — online evals flag issues, no dedicated clustering product | Have | `intelligence_rca.py:159-204` (`/incidents/cluster`, `/incidents/{cluster_id}/resolve` route handlers, using `IncidentClusterer` imported from `insights/incidents/clusterer.py`) |
| Faceted, always-on classification of 100% of traffic (task/sentiment/custom facets, not just failure events) | Unverified — Lemma's `extraction` object tracks per-thread completion, not a facet-classification product distinct from Issues | Missing — not found | **Have — Braintrust's headline 2026 feature** ([source](https://www.braintrust.dev/articles/what-are-topics-in-braintrust-2026)) | Missing | Missing | **Partial** (new row this pass) | `topics/service.py:18-59,147-212` (F65: `topic_clusters` table, facets task/sentiment/issues/custom) — but derived from top-50 `trace_patterns` via the existing clusterer on each `generate_topics` call, not an independent fresh per-trace LLM pass; `action="alert"` is a no-op stub (`service.py:230-231`) |
| Automatic failure discovery with no operator-authored judge/rubric required | Have (marketed as core positioning) | Partial — Engine's inputs include pre-defined "online evaluator failures" | Partial — Topics is itself an LLM judge under the hood | Missing | Missing | Have (eden differentiator, on the auto-propose side) | `soft_issue_review.py:333-376` (`_create_shadow_detector`) |
| Self-learning "shadow" detector lifecycle (auto-propose → auto-promote/delete on precision) | Missing — Lemma's `lanes_fired`/`validation.status`/`confirmation_verdict` fields (see Headline finding) are the closest documented analog found in 2026 research, but describe a fixed multi-lane ensemble with human-confirm tracking, not eden's precision-threshold auto-promote/auto-delete loop | Missing | Missing | Missing | Missing | Have (eden differentiator — closest analog now Lemma, still not equivalent) | `soft_issue_review.py:333-478` (precision≥0.8 & ≥20 firings → promote, precision<0.3 → delete); `soft_issue_review.py:510-568` (`evaluate_shadow_precision`) |
| Counterfactual trace forking (branch a real production trace at step N, apply edits, hybrid cached+live replay, fork-of-fork lineage) | Missing — not found | Missing — not found | Missing — not found | Missing — not found | Missing — not found | Have (eden differentiator — no competitor analog found, new row this pass) | `time_travel/forker.py:52-124` (`TraceForker.fork`) |
| Adversarial red-team probe suite (jailbreak/injection/PII/system-prompt/training-data-extraction probes, automated runner) | Missing — not found | Missing — not found | Missing — not found | Missing — not found | Missing — not found | Have (new row this pass) — closest external analog is **Patronus AI's Percival** (20+ agentic failure modes, [source](https://www.patronus.ai/agents)), not a matrix-tracked competitor pre-this-pass | `redteam/probes.py:334-511` (12 named probes), `probes.py:552-635` (`ProbeRunner.run_probe`/`.run_suite`) |
| Output + embedding drift detection (PSI-based distribution shift) | Missing — not evidenced | Missing — not evidenced | Missing — not evidenced | Missing — not evidenced | **Have — Phoenix embeddings/UMAP drift visualization is a named differentiator** ([source](https://makerstack.co/reviews/arize-phoenix-review/)) | Partial (new row this pass) — output-drift comparable, embedding-drift self-admitted as a cruder hash-bucket proxy, not a learned embedding model | `predictive/drift.py:1-38` (docstring self-admits the proxy), `drift.py:97-285` (`detect_output_drift`, `detect_embedding_drift`), `drift.py:286` (`_severity_for_psi`) |
| Pre-merge CI gate that replays actual production traces (not just a static eval dataset) against a PR's agent-config diff, posts a GitHub Check Run + PR comment | Missing — not found | Partial — Engine can open a fix PR post-hoc, not a pre-merge diff-triggered gate | Partial — GitHub Action CI-gates on quality regression, but against eval datasets, not stratified production-trace replay | Missing | Missing | Have (new row this pass, eden differentiator on the trace-replay-specificity axis) | `change_impact/preview.py:75-99,100+,426-477` (`ChangeDetector`, `ImpactPreviewOrchestrator`, `post_github_check_and_comment`); `integrations/github/oauth.py:558,581` (`create_check_run`, `create_pr_comment`) |
| Per-step (not just per-trace) judge/eval scoring | Unverified | Missing — not evidenced as a distinct per-step primitive | Missing — not evidenced | Missing — not evidenced | Missing — not evidenced | Partial (new row this pass) — storage/read primitive shipped, automatic per-step scoring loop is a self-documented v0.1 follow-up, not yet wired | `apm_depth/step_judges.py:1-22` (docstring: "v0 ship is stamping only"), `step_judges.py` (`StepJudgeStamper.stamp`/`get_step_judges`/`get_trace_steps`) |
| Persistent, evolving "spec of intended agent behavior" object (per-agent, versioned, auto-updated from prompts+traces+context) | **Have, confirmed this pass** — "learn-agent artifact" (`knowledge_md`+`mermaid`, versioned, regeneratable) — see `15-artifacts-behavior-record.md` for full depth ([source](https://docs.uselemma.ai/api-reference/artifacts/get-learn-agent-artifact-version.md)) | Missing | Missing | Missing | Missing | Missing | `evaluation/golden_dataset.py:61,72` (`expected_behavior` is a static per-*test-case* dict, not a living per-agent object); no `agent_spec`/`behavior_contract` object found anywhere in `src/eden` (grep across repo, re-confirmed this pass) |
| Auto-generated fix delivered as an opened GitHub PR | Have — via Lemma MCP | Have — Engine "can open a GitHub PR with the proposed change" | Partial — one-click prod-trace→dataset promotion + CI-gating Action, no auto-PR-with-fix | Missing | Missing | Missing, but **not GitHub-blind** (correction this pass) | `agents/evolution/components.py` (`IssuePromptEvolver.evolve_from_issue` creates an internal prompt-version candidate, no PR); eden *does* have a working GitHub Check-Run/PR-comment client (`integrations/github/oauth.py:558,581`), used by `change_impact/preview.py`, just not wired to this path |
| Issue lifecycle: triage → resolve → auto-generate regression tests → auto prompt-evolution | Partial — issue→fix→online-eval loop exists as PR+new-eval | Partial — clusters→diagnose→PR→suggested evaluator+offline-eval examples | Partial — one-click prod-trace→dataset promotion | Missing | Missing | Have (eden differentiator) | `agent_issues.py:166-234` (resolve→regression-case→prompt-evolution→KB flywheel) |
| Tool-call misuse detection via trained per-tool classifier | Missing | Missing | Missing — scorers/annotation exist, not an auto-trained per-tool-call classifier | Missing | Missing | Have (eden differentiator, F21 — no competitor analog found) | `tool_call_calibrator.py:15-101,206-254` (logistic regression, precision-floor gate 0.6) |
| Evals: dataset-driven experiments w/ LLM-judge scoring | Have | Have | Have — pluggable + Loop-generated scorers | Have | Have | Partial — see `02-evals-datasets.md` | out of this file's scope |
| Cost tracking (per-call / per-workflow spend) | Not evidenced beyond general framing | Have — unified LLM+retrieval+tool spend view | Have | Have — automatic capture | Have — span-based (agent runs = 40-75 spans, [source](https://www.cekura.ai/blogs/arize-ai-pricing)) | Partial — see `06-cost-governance.md` | `sessions.py:153-171,188-202` |
| Threshold-based production alerting (error rate/latency/cost → PagerDuty etc.) | Have — Live Alerts to Slack only, no PagerDuty found | Have — 5/15-min windows to PagerDuty/Dynatrace/webhook | Partial — quality-regression alerts via CI gate only | Have | Have — AX adds PagerDuty/OpsGenie (Phoenix OSS does not) | Partial — see `04-alerting-oncall.md` | PagerDuty dispatch is a literal no-op stub: `realtime/alert_stream.py:427-429` |
| Dataset management (curate golden sets from production traces) | Have | Have — "data flywheel" | Have — one-click promotion | Have | Have — one of Phoenix's 4 pillars | Partial — see `02-evals-datasets.md` | `agent_issues.py:182-184,472-499` |
| RBAC / org-scoped access control on mutating actions | Not evidenced | Enterprise-gated | Enterprise-gated | Enterprise-gated | AX-gated | Partial — see `07-security-compliance.md` | `intelligence_rca.py:11-16,28-36` |
| Multi-turn session timeline (turn-by-turn cards, linked issues) | Missing | Partial — thread/session grouping | Partial — traces group into sessions | Partial — "multi-turn conversation support" noted | Missing | Have | `sessions.py:181-211,264-280,283-290` |
| Synchronous, fail-closed pre-delivery guardrail enforcement (block before output reaches user) | Missing — Lemma is explicitly post-hoc | Missing | Missing | Missing — Langfuse's own docs admit this gap | Missing | Have | `guardrails/intervention.py:440-517` (fail-closed on no active policies) — Fiddler AI remains the one *extended-landscape* competitor with a documented real-time enforcement path |

## Extended landscape spot-checks (Galileo · Datadog · Helicone · PromptLayer · HoneyHive · Maxim AI · Traceloop · Fiddler/WhyLabs)

Unchanged from pass 2 — see that pass's sourcing; not re-verified this pass
so as to spend the research budget on new material (six new competitors,
six new eden modules, and the Lemma correction above).

| Capability | Who has it | eden comparison |
|---|---|---|
| LLM-judge distilled into a cheap/fast model for 100%-of-traffic synchronous scoring | **Galileo** (Luna-2, sub-200ms, ~$0.02/M tokens) | eden's `evaluate_and_act` is rule/policy-based, not a distilled-judge architecture |
| Real-time request/response-path guardrail enforcement (PII/PHI/secrets/jailbreak, in-environment small models) | **Fiddler AI** ("Centor Models," in-environment) | eden has fail-closed enforcement (`intervention.py:505-517`) but no dedicated small in-environment scoring model confirmed |
| Unsupervised weekly anomaly/outlier detection across ops metrics + evals | **Datadog** (Agent Observability Insights) | Closest eden analog is now **`predictive/drift.py`'s PSI-based drift detector** (new row above), not just the shadow-detector novelty path as pass 2 concluded — still narrower than Datadog's unsupervised anomaly sweep |
| Bundled AI gateway (multi-provider routing/caching/fallback) shipped natively with observability | **Helicone** (maintenance-mode post-Mintlify, March 2026) | eden's comparable-shape but dormant `AIGateway` (`llmops/ai_gateway.py`) — see `06-cost-governance.md` |
| Pre-deployment multi-turn agent simulation across scenario/persona sets | **Maxim AI**; also **Coval** (voice-specific, new this pass) and **Patronus AI** (Digital World Models, new this pass) | eden's `time_travel/forker.py` forks and edits *real* traces rather than generating synthetic scenarios — a different but adjacent capability, not a substitute |
| Vendor-neutral OTel-native SDK that pipes into an org's existing APM stack | **Traceloop/OpenLLMetry** (7,200+ stars) | eden is vertically integrated (own Postgres+Tinybird+Typesense stack) |
| No-code prompt editing surface for non-engineer domain experts | **PromptLayer** | Not evidenced in `src/eden` |
| Evaluation-Driven-Development framing + production-failure-to-test-case loop, self-hostable | **HoneyHive** | Same shape as `agent_issues.py` resolve→regression pipeline |
| Trained per-tool-call/agentic failure-mode classifier (20+ named failure types) | **Patronus AI Percival** (new this pass — closest external analog to eden's tool-call classifier + redteam probes found across all three research passes) | eden's `tool_call_calibrator.py` (logistic regression, single "misuse" class) + `redteam/probes.py` (12 named adversarial probes) together cover more named failure *categories* than a single Percival-style classifier, but as two separate, narrower systems rather than one unified 20+-mode detector |

## User Experience & Value

The matrix above compares capability *existence*; this section grounds
that in what a real eden user actually does today, in the actual portal
(`clients/portal/src/app/(portal)/`), verified this pass by reading the
route/component/API-client code directly (not inferred from the backend
alone, which was the gap in earlier drafts).

**Who the user is.** Every route below sits behind the same org-scoped
portal shell (`X-Org-Id` header, `useOrgQuery`/`portalApi`) — there is no
separate "domain expert" or "PM" surface, only one persona: the on-call or
on-duty AI/ML engineer responsible for a production agent, investigating a
failure or reviewing a fix. This matches the matrix's own RBAC row
characterization of eden's access control as still "Partial."

**The flow today, traced through real routes and endpoints:**
1. The engineer lands on `/traces` (`GET /orgs/{orgId}/portal/traces`,
   `clients/portal/src/lib/api/portal.ts:68-69`), which doubles as the
   Sessions view via `?view=sessions` — `sessions/page.tsx` is a one-line
   `redirect("/traces?view=sessions")`; Sessions is explicitly "a Traces
   lens, not a separate product leaf." Selecting a trace lazily hydrates
   the full transcript via `GET /orgs/{orgId}/portal/traces/{traceId}`
   (`portal.ts:77-81`) — the list payload always ships `steps: []` to
   avoid N+1 hydration.
2. Clicking a turn inside a session (`openTurn`,
   `traces/traces-client.tsx:541-555`) switches to the trace tab and
   shallow-routes to `?view=sessions&session={id}&id={traceId}` — a
   specific turn is always a shareable, bookmarkable URL.
3. For root-cause work, `/debugger/[id]` opens a Time Travel tab
   (`DebuggerTimeTravelView`, `src/lab/debugger/debugger-modes.tsx:721`)
   that is a real, working front end for `time_travel/forker.py`: the
   engineer scrubs the step timeline, optionally edits a step's prompt
   inline, and triggers fork-and-replay
   (`onForkAndReplay`, `debugger-modes.tsx:853`), which calls
   `POST /orgs/{orgId}/intelligence/time-travel/fork` then
   `.../replay` (`clients/portal/src/lib/api/resources.ts:3133,3141`) and
   fetches a structured diff via
   `GET /orgs/{orgId}/intelligence/time-travel/diff/{forkId}/{replayId}`
   (`resources.ts:3159`, rendered as `diffEntries`,
   `debugger-modes.tsx:990`). This is a genuinely working front door for
   eden's most-differentiated capability — not just a backend primitive.
4. Failures surface as grouped rows on `/issues`
   (`GET /orgs/{orgId}/portal/issues`, `portal.ts:86-87`), each with a
   `suggestedFix` string and, when eden couldn't draft a fix PR, a
   `patchBlockedReason`/`patchBlockedMessage` pair rendered inline
   (`issues-client.tsx:391-411`, e.g. `repo_not_connected`).

**Why this is valuable.** The trace → session → turn → fork chain is a
single, coherent investigation surface with a shareable URL at every step
— an engineer can paste a `/traces?view=sessions&session=...&id=...` link
into Slack and a teammate lands on the exact turn, not a generic
dashboard. The Time Travel fork+diff loop is the strongest concrete
realization in this whole matrix of a claimed differentiator
(counterfactual trace forking): it has a working UI with immediate diff
feedback, not just an API.

**What would make it more usable/adoptable — specific, verified gaps:**
- **Fork lineage is flat, not a tree.** `forksQuery`
  (`debugger-modes.tsx:750-763`) renders "Forks for this trace" as a flat
  list (`debugger-modes.tsx:1279-1300`) showing `fork_id`, `fork_at_step`,
  and `last_replay_outcome` — but the API already accepts `parent_fork_id`
  on both `record` and `fork` (`resources.ts:3114,3128`), so fork-of-fork
  lineage exists server-side and simply isn't rendered. Grouping the flat
  list by `parent_fork_id` into a nested tree is a small, high-leverage
  front-end fix.
- **Shadow-detector feedback has no front door anywhere in the portal.**
  A repo-wide grep for `shadow` under `clients/portal/src` returns only
  Tailwind `shadow-[...]` box-shadow utility classes — zero references to
  the shadow-detector precision/promote/delete lifecycle
  (`soft_issue_review.py:333-478`) or to `record_shadow_feedback` (which
  the memo independently reconfirmed has zero callers repo-wide). There is
  no confirm/dismiss UI anywhere for the capability this matrix calls
  eden's strongest differentiator; until `/issues` or `/traces` gets a
  confirm/dismiss affordance wired to that function, the feature is
  invisible to the only persona who could use it.
- **Issue fix-PR UX is half-built, not missing.** `IssueFixture`'s
  `patchBlockedReason`/`patchBlockedMessage` contract
  (`lab/fixtures/issues.ts:33-34`) presumes a working "attempt a fix PR,
  report why not" flow — but `IssuePromptEvolver.evolve_from_issue` only
  creates an internal prompt-version candidate (per this doc's own
  correction above), so today every issue effectively has an unpopulated
  "blocked" state rather than a real success/failure signal. Wiring
  `change_impact`'s existing GitHub write client
  (`integrations/github/oauth.py:558,581`) into this exact, already-built
  UI slot would close a gap the front end is already scaffolded for — this
  is a wiring task, not a design task.
- **Topics, drift, and red-team probes have no portal surface at all.**
  `topics/service.py`, `predictive/drift.py`, and `redteam/probes.py` have
  no corresponding route under `clients/portal/src/app/(portal)/` — no
  `/topics`, `/drift`, or `/redteam` page exists, and grepping `/issues`,
  `/signals`, and `/traces` for these capability names returns nothing.
  These are API-only today; until they get a route (or a tab inside
  `/signals`, which already hosts detector/automation config per the
  `AutomationsView` component), they cannot be adopted by the engineer
  persona this doc describes, regardless of backend maturity.

## Notes on evidence quality

- eden file:line references verified directly against `main` this pass
  (HEAD `6f2a09d3`, 2026-08-05): `src/eden/topics/service.py`,
  `src/eden/time_travel/forker.py`, `src/eden/redteam/probes.py`,
  `src/eden/predictive/drift.py`, `src/eden/change_impact/preview.py`,
  `src/eden/apm_depth/step_judges.py`, `src/eden/integrations/github/oauth.py`,
  plus re-confirmation of all pass-2 files
  (`intelligence_rca.py`, `signal_investigator.py`, `soft_issue_review.py`,
  `agent_issues.py`, `tool_call_labels.py`, `tool_call_calibrator.py`,
  `sessions.py`, `guardrails/intervention.py`, `realtime/alert_stream.py`,
  `agents/evolution/components.py`, `evaluation/golden_dataset.py`).
  **Two pinpoint citations corrected this pass (pass-4 review)**: the
  `topics/service.py` `action="alert"` stub is at lines 230-231, not
  226-227; the `intelligence_rca.py:159-204` citation for
  `IncidentClusterer` covers the route handlers that *use* the class
  (imported from `insights/incidents/clusterer.py`), not its definition.
  Both are line-number/precision fixes only — the substance of each claim
  was independently re-verified and stands.
- **Portal (frontend) verification, added this pass**: the User
  Experience & Value section's route/component/API-client citations were
  read directly against `clients/portal/src` on the same HEAD —
  `src/app/(portal)/traces/traces-client.tsx`, `src/app/(portal)/sessions/page.tsx`,
  `src/app/(portal)/issues/issues-client.tsx`, `src/lab/debugger/debugger-modes.tsx`,
  `src/lib/api/portal.ts`, `src/lib/api/resources.ts`, `src/lab/fixtures/issues.ts` —
  plus a repo-wide grep for `shadow` under `clients/portal/src` confirming
  zero shadow-detector-feedback UI references (only CSS `box-shadow`
  utility classes match).
- **Lemma "Artifacts"/"Issue Extraction" fact-check (corrected this pass)**:
  found via `docs.uselemma.ai/llms.txt` (Lemma's own published
  LLM-readable API sitemap) and the individual OpenAPI-reference pages it
  links to under `/api-reference/artifacts/*`, `/api-reference/issues/*`,
  and `/api-reference/traces/list-thread-issue-summaries.md`. These are
  public, unauthenticated documentation pages describing a real,
  versioned, tagged API surface (`Tag: Artifacts`) — not private-beta
  hearsay. **Both names are now treated as confirmed real Lemma product
  surfaces** for the purposes of this matrix and the two sibling specs
  (`15-artifacts-behavior-record.md`, `16-issue-extraction-online-evals.md`).
  The one caveat carried forward: neither term appears in Lemma's
  *marketing* prose (homepage/blog/changelog) — they are engineering/API
  terminology, which is why two passes of homepage-level research missed
  them.
- Competitor claims are drawn from public marketing/review/docs/API-
  reference pages, not from vendor source code — treat "Missing" cells as
  "not surfaced in available 2026 sources," not verified absence.
- New-competitor claims (Weave, Opik, Confident AI, AgentOps, Coval,
  Patronus AI) were each independently checked for 2026 activity before
  inclusion; Log10 was checked and excluded (pivoted to a different market
  — see above).
- Rows tagged "see `NN-*.md` for full depth" are intentionally kept thin
  here per the task's scope split across parallel research agents; the two
  new sibling docs (`15-`, `16-`) follow the same convention for Lemma's
  Artifacts/Issue-Extraction depth.

## Verdicts

- **"Artifacts" and "Issue Extraction" as named Lemma products —
  VERDICT REVERSED from pass 2.** Both are confirmed real via Lemma's own
  public API reference documentation (see Headline finding). Prior
  guidance to "not cite as fact" or caveat as unconfirmed is now
  **withdrawn**. Recommend citing both by name in any eden-vs-Lemma
  positioning material, with the nuance that they are API/engineering
  terms (not marketing-page terms) and that Lemma's Issues pipeline is a
  multi-lane, validation-gated, human-confirm-tracked system — closer in
  sophistication to eden's shadow-detector lifecycle than either prior
  pass credited.
- **"Have (eden differentiator — no competitor analog found)" rows for the
  shadow-detector lifecycle and the tool-call-misuse classifier** —
  VERDICT: KEEP, with a narrowed margin. Lemma's newly-confirmed
  `lanes_fired`/`validation.status`/`confirmation_verdict` fields are the
  closest documented analog to the shadow-detector lifecycle found across
  all three research passes (still not equivalent — no evidence of an
  automatic precision-threshold promote/delete loop on Lemma's side).
  Patronus AI's Percival (20+ named agentic failure modes) is the closest
  analog found to the tool-call-misuse classifier, though it is a single
  unified classifier rather than eden's two-system split (trained
  logistic-regression classifier + separate red-team probe suite).
  **`record_shadow_feedback` (`soft_issue_review.py:571`) still has zero
  callers** — re-confirmed this pass, unchanged from pass 2.
- **New rows this pass (Topics/facet-classification, trace forking,
  red-team probes, drift detection, CI trace-replay gate, per-step judges)
  — VERDICT: ADD, mixed maturity.** Trace forking (`time_travel/forker.py`)
  and the CI trace-replay gate (`change_impact/preview.py`) are the two
  strongest new differentiators — no competitor in either pass documents
  an equivalent. Topics, drift detection, and per-step judges are real but
  each carries a documented, self-admitted maturity gap (thinner than
  Braintrust's Topics, a hash-proxy instead of learned embeddings for
  drift, stamping-only with no automatic scoring loop for step judges) —
  recommend citing these as "shipped, narrower than the named competitor
  feature" rather than flat differentiators.
- **The "Issue lifecycle" and "auto-generated fix as PR" rows — VERDICT:
  RESCOPE, sharpened.** eden is not GitHub-blind (correction this pass —
  `integrations/github/oauth.py` has working Check-Run/PR-comment
  methods, used by `change_impact/preview.py`), but the issue-resolution
  path specifically still does not open a fix PR. Recommend framing as
  "eden has GitHub write infrastructure; it is wired to pre-merge impact
  preview today, not to post-resolution fix delivery" — a wiring gap, not
  a capability gap.
- **PagerDuty alerting** — VERDICT: KEEP (unchanged from pass 2). Dispatch
  is a literal no-op stub (`alert_stream.py:427-429`). Two of the
  competitors in this matrix are specifically sourced with live PagerDuty
  integration — LangSmith and Arize AX (see their matrix-row citations
  above); Langfuse's "Have" cell is not PagerDuty-specific, and
  AgentOps/Datadog are not sourced for PagerDuty anywhere in this document
  — cut from "5 of 18" per pass-4 review, which found the wider claim
  unsupported by this doc's own sourcing.
- **Competitor "Missing" cells generally — VERDICT: KEEP-WITH-CAVEAT**,
  now spanning 19 distinct named competitors across three passes
  (4 → 12 → 19, corrected this pass from a miscount of 18) — still
  directional, but the sample has grown enough that repeated "Missing"
  findings for a given capability (e.g., counterfactual trace forking,
  found nowhere in 19 competitors) should be read as a genuinely
  differentiated eden capability, not a research gap.

## Sources

- Lemma: [uselemma.ai](https://www.uselemma.ai/), [docs.uselemma.ai](https://docs.uselemma.ai/), [docs.uselemma.ai/llms.txt](https://docs.uselemma.ai/llms.txt), [docs.uselemma.ai/api-reference/artifacts/regenerate-project-artifacts](https://docs.uselemma.ai/api-reference/artifacts/regenerate-project-artifacts.md), [docs.uselemma.ai/api-reference/artifacts/get-learn-agent-artifact-version](https://docs.uselemma.ai/api-reference/artifacts/get-learn-agent-artifact-version.md), [docs.uselemma.ai/api-reference/artifacts/list-project-artifacts](https://docs.uselemma.ai/api-reference/artifacts/list-project-artifacts.md), [docs.uselemma.ai/api-reference/issues/get-issue-artifact-context](https://docs.uselemma.ai/api-reference/issues/get-issue-artifact-context.md), [docs.uselemma.ai/api-reference/issues/list-issues](https://docs.uselemma.ai/api-reference/issues/list-issues.md), [docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries](https://docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries.md), [uselemma.ai/blog/introducing-lemma](https://www.uselemma.ai/blog/introducing-lemma), [github.com/uselemma](https://github.com/uselemma), [x.com/uselemma_ai](https://x.com/uselemma_ai), [ycombinator.com/companies/uselemma](https://www.ycombinator.com/companies/uselemma), [fondo.com/blog/lemmaf25-launches](https://fondo.com/blog/lemmaf25-launches)
- LangSmith: [langchain.com/langsmith/observability](https://www.langchain.com/langsmith/observability), [langchain.com/blog/introducing-langsmith-engine](https://www.langchain.com/blog/introducing-langsmith-engine), [docs.langchain.com/langsmith/engine](https://docs.langchain.com/langsmith/engine), [inference.net/content/langsmith-pricing](https://inference.net/content/langsmith-pricing/), [morphllm.com/comparisons/langfuse-vs-langsmith](https://www.morphllm.com/comparisons/langfuse-vs-langsmith), [costbench.com/langsmith](https://costbench.com/software/ai-observability/langsmith/)
- Langfuse: [langfuse.com/resources/langsmith-alternative](https://langfuse.com/resources/engineering/langsmith-alternative), [github.com/orgs/langfuse/discussions/12926](https://github.com/orgs/langfuse/discussions/12926), [langfuse.com/self-hosting/troubleshooting-and-faq](https://langfuse.com/self-hosting/troubleshooting-and-faq), [github.com/langfuse/langfuse](https://github.com/langfuse/langfuse)
- Braintrust: [braintrust.dev/articles/agent-observability-complete-guide-2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026), [braintrust.dev/docs/changelog](https://www.braintrust.dev/docs/changelog), [braintrust.dev/articles/what-are-topics-in-braintrust-2026](https://www.braintrust.dev/articles/what-are-topics-in-braintrust-2026), [braintrust.dev/blog/announcing-series-b](https://www.braintrust.dev/blog/announcing-series-b)
- Arize Phoenix/AX: [makerstack.co/reviews/arize-phoenix-review](https://makerstack.co/reviews/arize-phoenix-review/), [laminar.sh/article/arize-phoenix-alternatives-2026](https://laminar.sh/article/arize-phoenix-alternatives-2026), [cekura.ai/blogs/arize-ai-pricing](https://www.cekura.ai/blogs/arize-ai-pricing), [costbench.com/arize-phoenix](https://costbench.com/software/ai-observability/arize-phoenix/)
- Weights & Biases Weave: [wandb.ai LLM observability report](https://wandb.ai/onlineinference/genai-research/reports/LLM-observability-Enhancing-AI-systems-with-W-B-Weave--VmlldzoxMjY4MjMwNQ), [braintrust.dev/articles/best-weights-and-biases-alternatives-2026](https://www.braintrust.dev/articles/best-weights-and-biases-alternatives-2026)
- Comet Opik: [comet.com/site/products/opik](https://www.comet.com/site/products/opik/), [baeseokjae.github.io/posts/comet-opik-review-2026](https://baeseokjae.github.io/posts/comet-opik-review-2026/)
- Confident AI/DeepEval: [confident-ai.com/pricing](https://www.confident-ai.com/pricing), [confident-ai.com/knowledge-base/compare/best-llm-evaluation-tools](https://www.confident-ai.com/knowledge-base/compare/best-llm-evaluation-tools)
- AgentOps: [mlflow.org/articles/what-is-agent-observability-a-2026-developer-guide](https://mlflow.org/articles/what-is-agent-observability-a-2026-developer-guide/), [arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/)
- Coval: [prnewswire.com Coval Series A](https://www.prnewswire.com/news-releases/coval-raises-28-million-series-a-to-define-safety-and-reliability-for-autonomous-voice-agents-302808740.html), [coval.dev/2026-voice-ai-report](https://www.coval.dev/2026-voice-ai-report)
- Patronus AI: [techcrunch.com/2026/06/25/patronus-ai-lands-50m](https://techcrunch.com/2026/06/25/patronus-ai-lands-50m-to-build-digital-worlds-that-stress-test-ai-agents/), [patronus.ai/agents](https://www.patronus.ai/agents)
- Log10 (excluded): [everest.log10.io](https://everest.log10.io/), [log10.io/news/seed](https://www.log10.io/news/seed)
- Extended landscape (Galileo, Datadog, Helicone, PromptLayer, HoneyHive, Maxim AI, Traceloop, Fiddler/WhyLabs) — unchanged from pass 2, see that pass's sourcing.
- eden code (verified 2026-08-05, HEAD `6f2a09d3`): `src/eden/topics/service.py`, `src/eden/time_travel/forker.py`, `src/eden/redteam/probes.py`, `src/eden/predictive/drift.py`, `src/eden/change_impact/preview.py`, `src/eden/apm_depth/step_judges.py`, `src/eden/integrations/github/oauth.py`, plus re-confirmed pass-2 files: `src/eden/api/routes/intelligence_rca.py`, `src/eden/api/routes/signal_investigator.py`, `src/eden/services/soft_issue_review.py`, `src/eden/api/routes/agent_issues.py`, `src/eden/api/routes/tool_call_labels.py`, `src/eden/learning/tool_call_calibrator.py`, `src/eden/api/routes/sessions.py`, `src/eden/guardrails/intervention.py`, `src/eden/realtime/alert_stream.py`, `src/eden/agents/evolution/components.py`, `src/eden/evaluation/golden_dataset.py`.
