# Pass 4 Notes — 09-sdk-dx.md — Sole Reviewer

Scope: re-verify every non-trivial claim against live source (`sdk/python`, `sdk/ts-ai`), confirm
consistency with the Go/Rust SDK deletion (`sdk-deletion.md`), prune false/speculative/redundant/filler
content, draft a "User Experience & Value" section (the doc currently has none). Did not edit the
source doc.

## VERIFIED

**Headline finding: this doc is already exceptionally well fact-checked.** I re-verified ~45 distinct
file:line citations across `sdk/python/eden_sdk/{config.py,client.py,__init__.py,doctor.py,
instrumentations/{openai,anthropic,bedrock,gemini}.py}` and `sdk/ts-ai/src/{types.ts,client.ts,
instrument.ts,detect-installed.ts,doctor.ts,instrumentations/openai.ts}` plus `package.json` and both
READMEs. Every single one matched exactly — line numbers, quoted code, quoted comments, and paraphrased
mechanism claims all check out. Spot-check highlights:

- `agent_id`/`agentId` plumbing (config field, env var, header, auto-stamp) — confirmed line-for-line in
  both SDKs: `config.py:136` (field), `config.py:40` (`_ENV_AGENT`), `config.py:374` (`_from_env`),
  `config.py:456-457` (`configure()` kwarg), `config.py:235-236` (`auth_headers()`), `client.py:565-569`
  (auto-stamp, comment verbatim). TS: `types.ts:49`, `client.ts:249`, `client.ts:1401`,
  `client.ts:731-735` (auto-stamp, comment verbatim) — all exact.
- README gap claim confirmed: `grep agent_id sdk/python/README.md` and `grep agentId
  sdk/ts-ai/README.md` each return exactly one hit, both inside the unrelated `begin(agent_id=...)`
  session-helper example (`README.md:106` / `README.md:178`) — the doc's claim that `agent_id` is
  undiscoverable from either quickstart is correct.
- `eden.init()` → `configure()` + `instrument()`, and `instrument()` iterating
  `instrumentations.__all__` when called with no args, both confirmed verbatim at
  `__init__.py:279-317` and `__init__.py:188-253`, including the OTel-exporter mutual-exclusion warning
  text at `__init__.py:210-220`.
- TS `instrument()` (`instrument.ts:50-58`) confirmed to do exactly what the doc says: gate
  `installHttpCapture` behind `opts.httpCapture === true`, and otherwise just return the twelve
  `wrap*` factories plus `detected` — no auto-patching.
- The "smoking gun" claim — `detect-installed.ts`'s eleven `_safeRequire(...)` call sites
  (`:65,70,75,80,85,95,105,112,118,124,130`) resolve the real module object and then discard it into a
  boolean (`if (_safeRequire("openai")) result.openai = true;`), and `autoInstrument()`
  (`detect-installed.ts:138-140`) is a bare alias for `detectInstalledFrameworks()` with zero patching —
  confirmed exactly, including that `_safeRequire` (`:21-46`) really does return the live resolved
  module namespace via `eval("require")` / `process.getBuiltinModule("module").createRequire(...)`.
- Python vs. TS monkey-patch mechanism claims (class-attribute reassignment vs. per-instance `Proxy`)
  confirmed at `openai.py:38,49-52`, `anthropic.py:30-33`, `bedrock.py:31-34`, `gemini.py:30-33` (Python)
  and `instrumentations/openai.ts:33-34,64-69` (TS `WeakMap`/`Symbol.for` idempotency guard).
- Self-health telemetry counters: Python `client.py:1564-1587` (`.sent`/`.dropped`/`.sampled_out`/
  `.server_sampled_out` properties), `client.py:629-637` (drop-count comment verbatim), `client.py:598-
  604` (100%-server-rejected-but-2xx comment). TS `client.ts:578,590,596` (`sampledOut`/`droppedTotal`/
  `lastIngestHttpStatus`), `client.ts:793,1330,1374` (increment sites), `doctor.ts:150` (reads
  `lastIngestHttpStatus`, does not read `droppedTotal`/`sampledOut` — confirmed by grep, no other
  reference to either field anywhere in `doctor.ts`). README doc-gap claims for both sides confirmed by
  grep (`droppedTotal` appears at `sdk/ts-ai/README.md:19,386`; Python README never mentions `dropped`/
  `sampled_out`).
- Batching/flush defaults (`batch_size=50`, `flush_interval_ms=250`, `max_queue=4096`,
  `config.py:137-142`), `atexit` best-effort flush, and the sender-thread-death `RuntimeError`
  (`client.py:536-539`, message text verbatim) — all confirmed exact.
- `package.json:8-37` subpath type-export claim confirmed (six `./instrumentations/*` + `./model-advisor`
  exports block, `"types": "./dist/index.d.ts"` at line 8).
- Doctor tooling parity claim (`doctor.ts` 197 lines, `doctor.py` 236 lines) confirmed via `wc -l`.
- `gen_ai\.` grep returning zero matches in both SDK source trees — reconfirmed, zero hits.
- Consistency with the Go/Rust deletion: the doc's scope note (line 5: "`sdk/go` and `sdk/rust` were
  removed from the repo in a separate, unrelated housekeeping pass this session and are not discussed
  further") is accurate and matches the current `git status` / `sdk-deletion.md` state exactly. The doc
  does **not** pitch Go/Rust SDK investment anywhere — the entire "Eden's actual state" section is
  explicitly scoped to `sdk/python` and `sdk/ts-ai` only ("surviving SDKs" in the H2 heading, line 19),
  the competitor table (line 84-90) has no Go/Rust column, and Recommendations 1-4 are all
  Python/TS-scoped. No edit is needed on this axis — this is a case where the doc already got it right
  before this pass started (likely fixed in an earlier pass, per `sdk-deletion.md`'s own note that this
  file is "not dangling, accurate").
- External-library mechanism claims (`require-in-the-middle` patches `Module.prototype.require`;
  `import-in-the-middle` uses `module.register()`/`registerHooks()` with the stated ESM ordering
  constraint) are consistent with well-documented, stable Node.js ecosystem behavior. Not re-fetched
  from GitHub source in this pass (external, not eden's own code, and not load-bearing for any
  eden-specific factual claim) — flagged here as "plausible, not independently re-verified this pass"
  rather than blanket-verified.

## CUT

Almost nothing here is false, speculative, or filler — this doc earned its "KEEP" verdict. The one
real issue found is a **citation/attribution error**, not a false technical claim:

> "The strongest, most actionable finding is not a new one — it's independent confirmation of Part 0.2
> in `INDEX.md`... Sequence it after the portal 'Create Agent' flow, as INDEX.md already specifies."
> (line 3)
>
> "sequenced strictly after Part 0.2's portal 'Create Agent' flow ships, per `INDEX.md` Part 0.2
> (`INDEX.md:27-44`, item 10 in the prioritized list at `INDEX.md:103`)" (line 94, Recommendation 1)

**Reason: the INDEX.md citation is verifiably wrong on three counts**, checked directly against the
live `INDEX.md`:
1. There is no section titled or numbered "Part 0.2" anywhere in `INDEX.md`. The only "Part 0" is a
   single flat, integer-numbered list ("### 1.", "### 2.", ... "### 16.") at `INDEX.md:51-460` — no
   decimal sub-numbering exists anywhere in the file (`grep -n "^#" INDEX.md` confirms the full heading
   structure has no "0.2").
2. `INDEX.md:27-44` is inside the Executive Summary, discussing the "sophisticated backend, missing
   last-mile wiring" pattern generally — it says nothing about `agent_id` or a portal "Create Agent"
   flow.
3. "Item 10 in the prioritized list" at `INDEX.md:103` doesn't exist as cited: line 103 falls inside
   finding #2 ("The entire P0 security-alert path is decorative"), and the actual item numbered 10 in
   Part 0's list is at `INDEX.md:311` — "`Artifacts` and `Issue Extraction` are now confirmed real
   Lemma products" — completely unrelated to `agent_id`.

The literal phrase **"Create Agent" appears nowhere in `INDEX.md`** (confirmed by repo-wide grep) — it
appears only in this one doc (`09-sdk-dx.md`, twice, at lines 3 and 94). The actual, correct INDEX.md
reference for this finding is `INDEX.md:660-661`, item **14** in the Phase C list under "### Phase C —
Rescope, expose, and hygiene" (`INDEX.md:654`): *"14. Portal-first agent registration + `agent_id`
required promotion (`features/09`) — already cheap, fully-plumbed in both SDKs."* — which does confirm
the same underlying substance (agent_id is fully plumbed, sequence after portal registration) but under
a different label (Phase C item 14, not "Part 0.2 item 10") and without ever using the phrase "Create
Agent."

**Recommendation for the doc owner:** fix the citation at lines 3 and 94 to point at `INDEX.md:660-661`
(Phase C, item 14) instead of the fabricated "Part 0.2"/"item 10"/"INDEX.md:103" reference. The
underlying claim (agent_id is fully plumbed, INDEX.md independently corroborates sequencing after
portal work) is true and doesn't need to be cut — only the citation needs correcting. Flagging as CUT
rather than a pure "keep as-is" because a reader who follows the citation as written will land on
unrelated content and lose trust in the doc's otherwise very high citation discipline.

No other content met the bar for CUT — no false claims, no unverifiable claims, no filler, and no
redundancy found against the other 15 `features/*.md` docs (none of the other 15 discuss SDK
instrumentation mechanics, `agent_id` plumbing, or onboarding-friction comparisons; `10-model-gateway.md`
was independently re-confirmed to have zero Go/Rust/SDK-instrumentation overlap with this doc).

## USER EXPERIENCE & VALUE

**What integrating eden into a new service actually feels like today, by language — grounded in the
real SDK code, not the marketing description.**

### Python: the good one-liner has an asterisk

The documented happy path (`sdk/python/README.md:26-49`) is genuinely competitive: `eden.configure(org_id=..., api_key=...)` then `eden.instrument()` auto-patches every installed framework
(OpenAI, Anthropic, LangChain, LlamaIndex, CrewAI, AutoGen, Mastra, Pydantic-AI, Bedrock, Gemini, Groq,
Cohere, Mistral) with zero further code changes anywhere in the app — on par with Traceloop's
`Traceloop.init()` and better than LangSmith/Braintrust's "wrap every client by hand" model. A
`@trace_agent` decorator covers the manual-instrumentation escape hatch. This is real, class-level
monkey-patching (`chat_completions.AsyncCompletions.create = wrapped`, `openai.py:52`), not a stub — it
intercepts calls from code the SDK never imported, which is the actual bar for "auto-instrumentation."

The asterisk: `eden.init()` — the literal one-call form — is explicitly marked **back-compat** in its own
docstring ("Older generated snippets called `eden.init(...)`. Prefer `eden.configure(...)` then
`eden.instrument(...)` in new code," `__init__.py:288-289`). The *currently recommended* path for a new
integration is two calls, same call-count as the TS SDK's `configure()` + per-client `wrap*()` — the
real Python advantage over TS isn't "fewer calls," it's that the second Python call (`instrument()`)
requires **zero per-provider, per-client-instance wiring**, where TS's second call has to be repeated
once per client object the app constructs. The onboarding-comparison table in the doc (line 86) states
"1 (`eden.init(...)`)" for Python's "calls to first trace" without this caveat — technically true only
for the deprecated path, and worth a footnote rather than a silent implication that the modern,
recommended quickstart is a single call.

**The single most consequential first-run failure mode is silent, in both SDKs, for the single most
common mistake (forgetting `org_id`) — and it is not obviously worse in Python despite Python's own
config code raising a `ValueError`.** `EdenConfig.ingest_url()` raises `ValueError("EdenConfig.org_id is
required to build the ingest URL")` at `config.py:216` — but this method is only ever called from
inside the background sender thread (`client.py:1238`), wrapped in a broad `except Exception as exc:
logger.warning(...)` a few lines later. `configure()` itself (`config.py:407+`) never calls
`ingest_url()` and performs no eager validation. **Net effect: a Python integration with a missing
`org_id` configures cleanly, instruments cleanly, and runs the app normally — the ValueError exists in
the code but never reaches user-visible output unless the host app happens to have `eden_sdk`'s Python
`logging` warnings surfaced**, which is not the default in most app setups (uvicorn/gunicorn access
logs, Django, etc. don't surface third-party library warnings by default). The only way to discover the
misconfiguration is to run `python -m eden_sdk.doctor` or to explicitly read the undocumented
`.dropped`/`.failed` counters.

TS actually does *better* here, and interestingly, TS's own source code contains a comment that
slightly overstates Python's behavior by comparison: `client.ts:280-295`'s handling of a missing
`orgId` includes an explicit `console.warn(...)` (visible on stderr by default, no logging
configuration required) with the comment *"The Python SDK raises a clear ValueError in the same
situation (config.py), so this at least brings the two into earshot."* That comment is accurate about
the ValueError's *existence* but not about its *reachability* — as shown above, that ValueError never
propagates to the Python caller in the default configuration; it's swallowed by the same kind of
best-effort background-thread catch-all that TS's own fire-and-forget design also relies on. **The
practical first-run experience for "I forgot to set an org ID" is actually more visible on the TS side
today** (an unconditional, synchronous `console.warn` at client-construction time) **than on the Python
side** (a caught exception, demoted to a `logging.warning` inside a background thread, invisible unless
the app's logging config happens to surface it) — the reverse of what a reader would conclude from
either SDK's own comments or README.

### TypeScript: the manual-wrap tax, and a function whose name overpromises

The TS SDK ships the same building blocks as Python — twelve `wrap*` functions, a `detect-installed.ts`
that can already tell you which frameworks are present, `doctor.ts` for diagnostics, `droppedTotal`/
`sampledOut` counters — but the DX gap is real and it's specifically in the assembly, not the
components. A developer wiring up a new Node service today writes:

```ts
import { configure, wrapOpenAI } from "@eden-ai/sdk";
configure({ orgId: "...", apiKey: "..." });
const client = wrapOpenAI(new OpenAI());   // repeat per client instance, per provider
```

— and must repeat the `wrap*()` call for every client instance constructed anywhere in the app,
including ones instantiated inside a dependency's own internals (e.g. LangChain's internal OpenAI
client), which are simply invisible to this pattern by construction (`instrumentations/openai.ts`'s
`Proxy` wraps one object instance; nothing touches `OpenAI.prototype`). For an app with LangChain,
direct OpenAI calls, and a Bedrock fallback, that's three separate wrap call sites to remember, in three
separate files, with no compiler or lint signal if one is missed — a silently-untraced code path with
no error, no warning, nothing in the console.

The sharper finding: **`detect-installed.ts` exports a function literally named `autoInstrument()`
(`detect-installed.ts:138-140`) that does not auto-instrument anything.** It is a one-line alias for
`detectInstalledFrameworks()` — pure detection, zero patching. A developer who reads that name and
calls it expecting Traceloop/Python-style zero-touch coverage gets back a `{ openai: true, anthropic:
false, ... }` boolean map and a completely unmodified, still-untraced app, with no runtime signal that
anything is missing — this is worse than "no auto-instrument exists" (a documented limitation you'd
plan around) because it's an API surface that actively suggests the opposite of what it does. This is
the single highest-leverage, lowest-cost DX fix identified in the doc's own Phase 1 plan (reusing the
module reference `_safeRequire` already resolves and currently discards) — and until it ships, the
function should either be renamed (`autoInstrument` → `detectFrameworks`, matching what it actually
does) or should log a one-time warning explaining it is detection-only, so the name stops actively
misleading integrators.

### Docs quality

Both READMEs (`sdk/python/README.md`, 481 lines; `sdk/ts-ai/README.md`, 440 lines) are substantive and
largely accurate against source — env var tables, framework-support matrices, and (on the TS side)
explicit documentation of the `droppedTotal` backpressure-loss counter are all genuinely useful and
verified consistent with the code. The public docs site (`docs/docs/quickstart.mdx`,
`docs/docs/reference/sdk-python.md`, `docs/docs/reference/sdk-typescript.md`) has zero dangling Go/Rust
SDK references, so the deletion didn't leave any doc-site debris. The one clear, low-cost documentation
gap — confirmed independently by this pass and matching the source doc's own finding — is `agent_id`/
`agentId` being invisible as a top-level `configure()` option in either README (it only appears inside
the unrelated `begin()` session-helper example).

**Bottom line on genuinely-good DX vs. today:** the components for a best-in-class onboarding
experience already exist on both sides — real class-level monkey-patching proven out in Python, a
correctly-designed (if incompletely wired) detection layer in TS, real self-health counters, and a real
diagnostic CLI on both sides. What's missing is not engineering effort in new areas, it's finishing two
specific, already-scoped threads: (1) making the *default*, no-flags-needed first-run experience
fail loud instead of fail quiet for the single most common misconfiguration (missing `org_id`) on the
Python side specifically, since TS already does this correctly; and (2) closing the TS auto-patch gap
so `wrap*()` becomes an escape hatch for edge cases rather than the mandatory path for every client
instance in the app — which is exactly what this doc's own Phase 1 plan (reusing the discarded
`_safeRequire` module reference) already proposes.

## NEW FINDINGS

1. **INDEX.md citation error** (detailed in CUT above) — the doc's headline framing ("Part 0.2 item 10,
   INDEX.md:103") points at unrelated content (a Lemma-products finding, not agent_id). Correct
   reference is `INDEX.md:660-661`, Phase C item 14.
2. **The "1 call to first trace" framing for Python** (onboarding comparison table, line 86) reflects
   the deprecated `eden.init()` back-compat path, not the currently-recommended `configure()` +
   `instrument()` two-call quickstart shown in the README and in the doc's own line-30 discussion. Worth
   a one-line footnote, not a correction of substance — Python's real advantage is zero-per-client
   wiring inside its second call, not fewer calls than TS.
3. **`console.warn` vs. `ValueError` characterization mismatch.** TS's own source comment
   (`client.ts:288-289`) states Python "raises a clear ValueError" for a missing `org_id` — true of the
   code's existence, false of its reachability in practice (caught and demoted to a background-thread
   `logging.warning` at the only call site, `client.py:1238` → `except Exception: logger.warning(...)`
   a few lines later). This means the actual first-run failure-visibility ranking between the two SDKs
   is closer to reversed from what either SDK's own comments suggest. Not previously identified in the
   source doc.
4. **`autoInstrument()` naming risk.** Beyond the doc's existing finding that `detect-installed.ts`
   discards the module reference it needs (already well-covered), the specific fact that the resulting
   detection-only function is *named* `autoInstrument()` (not e.g. `detectFrameworks()`) is a distinct,
   additional DX/trust issue worth calling out explicitly — an API that actively promises behavior it
   doesn't deliver, silently. Recommend either a rename or a one-time runtime warning as a near-zero-cost
   interim fix, independent of and cheaper than the doc's Phase 1/Phase 2 patching work.
5. No redundancy found against the other 15 `docs/specs/strategic-review-2026-08/features/*.md` docs —
   `09-sdk-dx.md` is the sole document discussing client-SDK instrumentation mechanics, and
   `10-model-gateway.md` was reconfirmed (independently of `sdk-deletion.md`'s own audit) to have zero
   overlapping content.
