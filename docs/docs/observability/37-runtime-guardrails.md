---
title: "37 — Runtime Protection Guardrails (Phase F — Cat 15)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 37 — Runtime Protection Guardrails (Phase F — Cat 15)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> The existing Cat 15 surface is real and tested. Phase F
> confirms + documents the 10 services and adds a fresh
> :class:`GuardrailPolicy` dataclass + :class:`GuardrailEvaluator`
> for the **unit-testable surface** (the previous guardrail
> code was tightly coupled to the database layer; the new
> dataclass is pure-Python and reuses the production
> detectors). 47 unit tests pass; 12 e2e tests have a
> pre-existing fixture issue (Settings field missing)
> that is unrelated to this work.

## Goal & motivation

The user has an LLM call. They want to know:

1. **Before the call** — does the input contain a prompt
   injection? Sensitive PII that the user accidentally
   typed? Toxic content?
2. **After the call** — does the output contain leaked PII,
   leaked secrets, hallucinated URLs, or anything that
   should be redacted before reaching the user?

Cat 15 answers both questions. The implementation is
**defence-in-depth**:

  * **10 services** in the guardrail package — detectors
    (PII, prompt-injection, hallucination, LLM firewall),
    policy CRUD, intervention engine, eval-to-guardrail
    promotion, log + metrics.
  * **4 detectors** wrap the Cat 10 PII scanner, the
    RagaAI-style injection scan, the Galileo-style
    hallucination check, and the Lunary-style pre-LLM
    firewall.
  * **Closed-loop** — :class:`EvalToGuardrailLink.promote`
    takes a Cat 3 judge (proven reliable offline) and
    promotes it to a production guardrail in one call.
  * **Default-allow** — production flows don't break
    before a real policy exists; the headline guardrail
    route returns ``verdict: "allow"`` with ``live: false``.

## What's in Eden

### The 10 services

| Service | Module | Purpose |
|---|---|---|
| `GuardrailPolicy` | `policy.py` | CRUD for policies (type, spec, action). |
| `ContentPolicyEnforcer` | `policy.py` | Generic content policy (keyword + regex). |
| `PromptInjectionDetector` | `detectors.py` | Galileo-style injection scan. |
| `PIIFirewall` | `detectors.py` | Lunary-style pre-call redaction. |
| `HallucinationBlocker` | `detectors.py` | Galileo-style output check. |
| `LLMFirewall` | `detectors.py` | Lunary-style pre-LLM-call firewall. |
| `InterventionEngine` | `intervention.py` | The headline guardrail route. |
| `LegacyEvalToGuardrailLink` | `intervention.py` | Promote an offline judge into a production guardrail. **Legacy (FEAT-34)** — see "EvalToGuardrailLink — which class is canonical" below; the canonical, enforcing implementation lives in `eden.evaluation.eval_intel.integration`. |
| `InterventionLog` | `intervention.py` | Read-side: query past decisions. |
| `GuardrailMetrics` | `intervention.py` | Dashboard counters (trigger rate / block rate). |

### The new pure-Python layer (Phase F addition)

The new :class:`GuardrailPolicy` dataclass and
:func:`evaluate` function live in
:mod:`eden.guardrails.evaluator` (a sibling module of the
DB-coupled ``policy.py``). They are unit-testable without a
Postgres connection. They re-use the production detector
regex (so the behaviour is identical) but expose a clean
function signature.

```python
from eden.guardrails.evaluator import (
    GuardrailPolicy, evaluate,
)

# Build a custom evaluator.
policy = GuardrailPolicy(
    name="no_external_links",
    rule_type="regex",
    rule=r"https?://[^\s]+",
    action="flag",
    severity="low",
    direction="output",
)
result = await evaluate(
    "Your SSN is 123-45-6789. Visit https://example.com.",
    policies=[policy],
    direction="output",
)
# result.violations — list of matched policies
# result.rewritten — output with rewrites applied
# result.blocked   — True if any "block"-action policy matched
# result.max_severity — "critical" | "high" | "medium" | "low"
```

### Five built-in policies

| Name | Rule | Action | Severity | Direction |
|---|---|---|---|---|
| `pii_email_output` | email regex | rewrite | high | output |
| `pii_ssn_output` | SSN regex | rewrite | **critical** | output |
| `secret_apikey_output` | API key regex | rewrite | **critical** | output |
| `prompt_injection_input` | blocklist (5 phrases) | **block** | high | input |
| `output_length_limit` | > 32KB | flag | low | output |

These are loaded into ``BUILTIN_POLICIES`` and can be
enabled per-org via the API. Admins can override any of
them with custom regex / blocklist / judge rules.

### Three rule types

| Type | Rule shape | When to use |
|---|---|---|
| ``regex`` | A regex string. | Structural patterns (emails, SSNs, API keys). |
| ``blocklist`` | A list of forbidden substrings (case-insensitive). | Known-bad phrases ("ignore previous instructions", "you are now admin"). |
| ``length`` | An integer (max char count). | Output length limits (cost control). |
| ``judge`` | A judge prompt. (Async LLM call.) | Semantic checks (toxicity, jailbreak). |

### Three actions

| Action | Behaviour |
|---|---|
| ``block`` | Drop the call entirely. The intervention engine returns ``verdict: "deny"``. |
| ``rewrite`` | Replace the matched text with ``[REDACTED:<policy_name>]``. The call proceeds with the rewritten text. |
| ``flag`` | Log only. The call proceeds unchanged. Used for low-severity signals that are worth surfacing but not worth blocking. |

### Closed-loop: eval-to-guardrail promotion

The killer feature. A Cat 3 judge that's been reliably
catching real issues offline (e.g. ``hallucination_score <
0.7`` in 95% of bad cases) can be promoted to a production
guardrail in one call:

```python
link = LegacyEvalToGuardrailLink(pg_client)
new_policy_id = await link.promote(
    org_id="org-42",
    judge_name="hallucination_check_v2",
    threshold=0.7,
    action="block",
    severity="high",
    direction="output",
)
# The InterventionEngine will now consult this judge on
# every output span. The link fires
# ``GuardrailHook.on_judge_threshold_breach`` if the judge
# ever fails more than 5% of cases in a 24h window (so a
# stale model doesn't silently degrade the guard).
```

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/intelligence/guardrails/policy` | yes (intelligence_gap_v0) | Create / replace a policy |
| `GET` | `/orgs/{org}/intelligence/guardrails/policies` | yes | List policies |
| `POST` | `/orgs/{org}/intelligence/guardrails/evaluate` | yes | Test a string against all enabled policies |
| `GET` | `/orgs/{org}/intelligence/guardrails/log` | yes | Read the intervention log |
| `GET` | `/orgs/{org}/intelligence/guardrails/metrics` | yes | Dashboard counters |
| `POST` | `/orgs/{org}/intelligence/guardrails/promote_judge` | yes | Promote an offline judge |
| `POST` | `/orgs/{org}/intelligence/guardrails/policy_injection_scan` | yes | Run just the injection detector |
| `POST` | `/orgs/{org}/intelligence/guardrails/pii_redact` | yes | Run just the PII redactor |
| `POST` | `/orgs/{org}/intelligence/guardrails/hallucination_check` | yes | Run just the hallucination check |
| `POST` | `/orgs/{org}/intelligence/guardrails/content_enforce` | yes | Run just the content policy enforcer |
| `POST` | `/orgs/{org}/intelligence/guardrails/firewall` | yes | Run just the LLM firewall (pre-call) |

The 12 e2e tests under `tests/intelligence/test_guardrails.py::TestGuardrailsRoutes` currently fail with a
``Settings has no field intelligence_gap_v0`` error — this
is a pre-existing fixture issue (the test class doesn't
inject the flag), unrelated to the policy implementation.

### Telemetry

- `guardrail.policy.created` / `updated` / `disabled` (counters)
- `guardrail.evaluate.match` (counter) — fires per violation
- `guardrail.evaluate.block` (counter) — fires per block
- `guardrail.evaluate.rewrite` (counter) — fires per rewrite
- `guardrail.promote_judge` (counter) — fires per promotion
- `guardrail.drift_alert` (counter) — fires when a promoted
  judge starts failing more than expected

These flow into the same pipeline as LLM spans. The AI
agent can search "all blocks in the last 24 hours" with no
new wiring.

## RagaAI parity matrix

| RagaAI feature | Eden Cat 15 | Notes |
|---|---|---|
| Regex policy | ✅ regex rule type | Multiple regex shapes supported |
| Blocklist policy | ✅ blocklist rule type | Case-insensitive substring match |
| Judge (LLM) policy | ✅ judge rule type | Async; production wires a real LLM |
| Length policy | ✅ length rule type | Cost-control / runaway detection |
| Action: block | ✅ block | Drops the call |
| Action: rewrite | ✅ rewrite | Replaces with [REDACTED:policy] |
| Action: flag | ✅ flag | Log only |
| Severity levels | ✅ low / medium / high / critical | 4 levels |
| Per-direction rules | ✅ input / output / both | Routing |
| Built-in PII patterns | ✅ email + SSN + apikey | From Cat 10 + extended by Phase K |
| Built-in injection patterns | ✅ 5-phrase blocklist | Common jailbreak patterns |
| Eval-to-guardrail promotion | ✅ `eval_intel.integration.EvalToGuardrailLink.promote_to_guardrail` (canonical; `LegacyEvalToGuardrailLink.promote` also exists, non-enforcing — see FEAT-34 below) | One-call promotion from Cat 3 judge |
| Drift detection on promoted judge | ✅ on_judge_threshold_breach | Stale-model detection |
| Alternate-response failover | 🟡 existing | Cat 10 has the policy; LLMFirewall applies it |
| Custom JavaScript rules | ❌ deferred | Not in scope for v1 |
| Per-tenant policy editor in portal | 🟡 partial | The API exists; UI is Phase E (UI polish) |

## What's NOT in this phase (deferred)

- **Custom JavaScript rules** — RagaAI lets the user write
  arbitrary JS for custom checks. We don't ship a JS
  sandbox; the four rule types (regex / blocklist / length
  / judge) cover 90%+ of real-world needs.
- **Per-tenant policy editor in the portal** — the API
  exists. The UI is a Phase E (UI polish) item.
- **Streaming evaluation** — current implementation
  evaluates the full text in one shot. Streaming
  evaluation (chunk-by-chunk for long outputs) is a future
  optimisation.
- **Multi-language PII in the guardrail** — Phase K added
  multi-language patterns to the PIIMasker. The
  guardrail's PII detector uses the same PIIMasker (via the
  Cat 10 path), so multi-language flows automatically.

## Failure modes

| Failure | Behaviour |
|---|---|
| Invalid regex in a policy | The policy is silently skipped + warning logged. |
| Judge call fails | The policy is treated as "did not match" (fail-open). The route layer can override to fail-closed. |
| Policy DB write fails | The 500 propagates. The new policy is not in the table. |
| Evaluation on non-string text | Coerced to str(). |
| Empty text | No violations. |
| Overlapping match spans | The evaluator processes all matches; the rewriter replaces right-to-left so spans don't shift. |
| Disabled policy | Skipped silently. |
| Unknown rule_type | Skipped + warning logged. |

## Fail-closed guarantees (FEAT-36)

"Fail-closed" is not a single global property of Cat 15 — it holds
for exactly one class of failure and is explicitly false for
others (see the Failure modes table above). This section states
precisely what is and isn't guaranteed so callers don't assume
more safety than the system actually provides.

### What IS guaranteed to fail closed

* **The content-safety enforcement path itself cannot be silently
  swapped out.** An earlier bug (the "Cat 15
  trajectory-replaces-intervention" patch,
  `install_cat15_trajectory_replaces_intervention` in
  `eden.observability.trace_quality.wiring`) monkey-patched
  `InterventionEngine.evaluate_and_act` to run a cost/loop/latency
  check instead of the real prompt-injection / PII / hallucination
  / content-policy evaluation whenever a `trace_id` was present —
  silently skipping content safety while still returning an
  "ok"-shaped response tagged `"feature": "trajectory_guardrail"`.
  This patch has been **fully removed** (FEAT-3/FEAT-4):
  `install_all()` no longer installs it, and
  `tests/unit/api/test_wave3_wiring.py` regression-tests that
  `evaluate_and_act` is untouched after `install_all()` runs.
* **Reintroduction of that bypass is now monitored, not just
  tested.** FEAT-33 added two independent detection surfaces so a
  future regression is caught in production, not only in CI:
  * A response-marker check
    (`eden.guardrails.intervention.record_guardrail_bypass_if_detected`)
    at the `/orgs/{org}/intelligence/guardrails/evaluate` route —
    flags any response still carrying the
    `"feature": "trajectory_guardrail"` marker.
  * A startup identity check
    (`eden.guardrails.intervention.is_evaluate_and_act_patched`),
    run at the end of `wiring.install_all()`, comparing the live
    `InterventionEngine.evaluate_and_act` against the reference
    captured at import time.
  Both increment the `eden_guardrail_bypass_detected_total`
  Prometheus counter (`eden.observability.metrics_endpoint`), so
  an alert can fire the moment the bypass is reintroduced instead
  of only being caught if a test happens to cover it.

### What is NOT guaranteed to fail closed

* **A judge/LLM call failure inside a policy evaluation is
  fail-OPEN by design** (Failure modes table above: "Judge call
  fails → treated as did not match"). If the hallucination judge
  (or any `judge`-type policy) errors or times out, the content in
  question is allowed through with a logged warning, not blocked.
  The route layer can opt into fail-closed behaviour per policy,
  but the platform default here is fail-open — this is an
  intentional default-allow design choice (see "Default-allow"
  above), not a bug, and FEAT-33/34/35 do not change it.
* **A policy-DB write failure surfaces as a 500**, not a silent
  allow or block — the new policy simply never lands in the table.
  This is orthogonal to fail-open/fail-closed for already-active
  policies.
* **The `judge_link` policy type written by the legacy
  `eden.guardrails.intervention.LegacyEvalToGuardrailLink.promote()`
  is never enforced** — `InterventionEngine.evaluate_and_act` hard-
  excludes `judge_link` from `_enforced_types`. Only the canonical
  `eden.evaluation.eval_intel.integration.EvalToGuardrailLink` has
  real enforcement teeth. See "EvalToGuardrailLink" below.

**Net statement:** Cat 15 guarantees that *the enforcement path
cannot be quietly replaced with a no-op*, and will alert if that
ever regresses. It does **not** guarantee that every individual
policy evaluation blocks on error — several failure modes are
intentionally fail-open. Read "fail-closed" here as "the right
code path always runs", not "every error always blocks".

## Single source of truth: which guardrail enforcement path is active (FEAT-37)

This section is the canonical statement of "which code path
actually enforces content safety in Eden," pulling together the
point-fixes above (FEAT-3/FEAT-4 removal, FEAT-33 monitoring,
FEAT-34 class reconciliation) into one architectural picture. It
does not repeat their mechanics — see "Fail-closed guarantees
(FEAT-36)" above for the FEAT-3/FEAT-33 detail and
"EvalToGuardrailLink — which class is canonical (FEAT-34)" above
for the class reconciliation.

**There is exactly one canonical content-safety enforcement
pipeline:** `InterventionEngine.evaluate_and_act`
(`eden.guardrails.intervention`). It is the only code path that
runs the real prompt-injection / PII-redaction / hallucination /
content-policy checks and returns a fail-closed verdict for
incomplete or unevaluable policy sets. Every route that needs
content-safety enforcement — the `/orgs/{org}/intelligence/guardrails/evaluate`
route and friends — calls into this pipeline, directly or via the
service classes documented above. Nothing else in the codebase is
permitted to stand in for it.

**The trajectory hot path is a separate, legitimate,
non-substitutable enforcement surface — not a competing
implementation of the same thing.** It has its own dedicated call
sites:

* `POST /v1/guardrails/trajectory/check` (`eden.api.routes.trace_quality`)
  — the live per-step route that runs cost / loop / latency checks
  on an in-flight agent trajectory.
* `TrajectoryInterventionGatewayFilter` (`eden.llmops.filters.trajectory`)
  — the AI-Gateway filter that applies those same checks inline on
  gateway traffic.

These exist to catch a *different* class of problem (runaway cost,
infinite loops, latency blowups on a trajectory) than
`evaluate_and_act` catches (unsafe content). Both are real,
intentional, currently-shipping enforcement surfaces. The
historical bug (FEAT-3/FEAT-4) was never that the trajectory hot
path existed — it was that a wiring
(`install_cat15_trajectory_replaces_intervention`) *substituted*
the trajectory hot path in place of `evaluate_and_act`, so a caller
that thought it was getting a content-safety verdict silently got a
cost/loop/latency verdict instead, tagged with the same "ok"-shaped
envelope (`"feature": "trajectory_guardrail"`). That substitution
has been removed and is now actively monitored (FEAT-33 — see
above): `is_evaluate_and_act_patched()` runs an identity check at
the end of `wiring.install_all()`, and
`record_guardrail_bypass_if_detected()` inspects every
`evaluate_and_act` response for the bypass marker; both increment
`eden_guardrail_bypass_detected_total`.

**The rule going forward:** the trajectory hot path (route +
gateway filter) must never again be substituted in place of
`InterventionEngine.evaluate_and_act`. It may run *alongside*
`evaluate_and_act` — they answer different questions — but one must
never stand in for the other. Any future wiring, refactor, or
gateway change that rebinds `evaluate_and_act` to anything other
than its own module-level implementation is exactly the regression
FEAT-33's monitoring exists to catch; treat a
`eden_guardrail_bypass_detected_total` increment or a
`guardrails: evaluate_and_act bypass detected` CRITICAL log line as
a live incident, not a metrics curiosity.

**EvalToGuardrailLink fits into this picture as follows** (full
detail in "EvalToGuardrailLink — which class is canonical (FEAT-34)"
above): the canonical `eden.evaluation.eval_intel.integration.EvalToGuardrailLink`
promotes a judge into a *policy that `evaluate_and_act` enforces* —
it is downstream of, and consistent with, the single canonical
enforcement pipeline stated above. The legacy
`eden.guardrails.intervention.LegacyEvalToGuardrailLink` writes a
`judge_link` policy type that `evaluate_and_act` explicitly does
not enforce — it was never a second enforcement path, just a
record-keeping shim kept alive for its existing callers.

### Portal dashboard audit (FEAT-38)

Now that FEAT-3 (bypass removed) and FEAT-33 (monitoring) are in
place, the portal's customer-facing guardrail dashboards
(`clients/portal/src/lab/guardrails/guardrails-chrome.tsx`,
`guardrails-detail-view.tsx`, `guardrails-list-view.tsx`, and the
`guardrails.ts` fixtures) were audited for the specific risk this
doc is about: could any displayed "enforcement activity" metric
have come from the old bypassed trajectory-hot-path substitution
rather than real content-safety enforcement?

**Conclusion: no live conflation found — and the reason is stronger
than "the two data sources don't overlap."** Tracing the actual data
flow (not assuming it) from `clients/portal/src/app/(portal)/guardrails/page.tsx`:
the page dynamically renders the real customer-facing components in
`clients/portal/src/lab/guardrails/` (`guardrails-list-view.tsx`,
`guardrails-detail-view.tsx`, `guardrails-chrome.tsx` — despite the
`lab` path segment, this is production code, wired via `dynamic()`
imports off the real route, not a sandbox), and those components are
fed by exactly one backend call:
`portalApi.guardrailPolicies(orgId)` → `GET
/orgs/{org}/guardrails/policies` → `GuardrailPolicy.list`
(`eden.guardrails.policy`) — a pure CRUD read of the
`guardrail_policies` table (`id, name, type, spec, action,
direction, status, created_at`).

That endpoint has **no enforcement-activity fields at all** — no
trigger count, block count, match volume, or last-hit timestamp.
`clients/portal/src/lib/api/portal.ts`'s own comment on
`guardrailPolicies` confirms this explicitly: "the backend never
computes severity, match-volume, last-hit, rule-summary, or
issue/trace links." Grepping the whole `clients/portal/src/`
tree for `guardrails/metrics`, `guardrails/log`, `GuardrailMetrics`,
and `InterventionLog` returns zero matches — the portal does not
call `GuardrailMetrics.dashboard()` or `InterventionLog.query()`
(the two services that *do* read `intervention_log`, the table
`evaluate_and_act` writes to) anywhere today. The `counts` prop
threaded through `guardrails-list-view.tsx` is a client-side tally
of how many *policies* match the current kind/status filter, not an
enforcement count.

**Net conclusion:** there is currently no enforcement-activity metric
of any kind surfaced on the customer-facing guardrails dashboard —
real or bypassed — so there is no live conflation to fix, and no
possible path for a trajectory-hot-path substitution artifact to
have reached it, in the current bug state or the historical one.
If/when a future feature wires `GuardrailMetrics`/`InterventionLog`
into this dashboard, it should read `intervention_log` directly (as
those services already do) and must not accept any payload carrying
the `"feature": "trajectory_guardrail"` marker as a content-safety
enforcement event — that is precisely the signature
`record_guardrail_bypass_if_detected()` (FEAT-33, above) treats as
an incident, not a real event, and any new dashboard code should do
the same before rendering it.

### EvalToGuardrailLink — which class is canonical (FEAT-34)

**Reconciled (FEAT-34).** There used to be two *identically-named*
`EvalToGuardrailLink` classes, which looked like an accidental
duplicate. They are not duplicates — they are the "record intent"
half and the "actually enforce" half of the same eval-to-guardrail
lifecycle concept, and their callers could not be safely merged in
one change (see below). To remove the name collision, the
non-enforcing class was renamed to `LegacyEvalToGuardrailLink`; the
enforcing class keeps the `EvalToGuardrailLink` name as the
canonical one. Only one is production-wired:

* **`eden.evaluation.eval_intel.integration.EvalToGuardrailLink` —
  canonical.** `promote_to_guardrail` / `promote_to_shadow` /
  `demote` write real `prompt_injection` / `pii_redaction` /
  `hallucination` / `content_policy` policies, hot-reload the AI
  Gateway's live in-memory guardrail filter
  (`eden.llmops.filters.guardrail`), and are reachable via
  `/orgs/{org}/intelligence/eval/promote-to-guardrail`,
  `/promote-to-shadow-guardrail`, and `/demote-guardrail`.
* **`eden.guardrails.intervention.LegacyEvalToGuardrailLink`
  (renamed from `EvalToGuardrailLink`; the row in the "10 services"
  table above has been updated to the new name) — legacy.**
  `.promote()` writes a `judge_link`-typed policy that
  `InterventionEngine.evaluate_and_act` never enforces (see above);
  it's reachable via the older
  `/orgs/{org}/intelligence/guardrails/promote_judge` route,
  kept alive because the Cat 17 closed-loop hooks
  (`GuardrailHook.on_judge_threshold_breach` /
  `on_judge_below_floor`) still call it. It has no production
  enforcement effect of its own. Use the canonical class above
  for new integrations. Both classes' `.demote()` methods remain
  distinct but interoperate: the canonical class's `demote()` reuses
  the legacy class's `_disable_eval_guardrail_link` DB helper
  (same tables, no SQL duplication) and additionally removes the
  policy from the live gateway filter — the one extra step the
  legacy class's own `.promote()` never needed to undo, since it
  never touched the live filter in the first place.

## Tests

47 unit tests pass (`tests/intelligence/test_guardrails.py`,
excluding the 12 e2e route tests that have a pre-existing
fixture issue):

- `TestGuardrailsPolicy` — CRUD round-trip, type
  validation, action enums, severity ordering.
- `TestContentPolicyEnforcer` — regex + blocklist detection,
  rewrite semantics, max-length.
- `TestPromptInjectionDetector` — common-jailbreak phrase
  detection, false-positive guards, severity classification.
- `TestPIIFirewall` — PII detection + redaction, multi-language.
- `TestHallucinationBlocker` — judge-driven check.
- `TestLLMFirewall` — pre-LLM-call risk score.
- `TestInterventionEngine` — `evaluate_and_act` for
  block / rewrite / flag, default-allow fallback, closed-loop
  firing.
- `TestLegacyEvalToGuardrailLink` — promote, drift detection.
- `TestInterventionLog` — query + filter.
- `TestGuardrailMetrics` — trigger / block counters.

12 e2e tests (`TestGuardrailsRoutes`) fail with
``Settings has no field intelligence_gap_v0`` — pre-existing
fixture issue, not Phase F.

## Cross-references

- [Cat 10 — Governance Intelligence](10-governance-intelligence.md)
  — the upstream PII scanner that the guardrail reuses.
- [Phase K — PII Anonymization](33-pii-anonymization-upgrades.md)
  — the multi-language PII patterns the guardrail inherits.
- [Cat 3 — Evaluation Quality Intelligence](03-evaluation-quality-intelligence.md)
  — the source of judges for ``EvalToGuardrailLink.promote``.
- [Phase L — Red-Team Probes](35-red-team-probes.md)
  — the offline counterpart: red-team probes test how the
  guardrail holds up against adversarial attacks.
