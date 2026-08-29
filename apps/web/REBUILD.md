# Rebuild — gated, one phase at a time

Process:

1. This plan is approved **before any pixels**.
2. One phase. Stop. You open the URL and look.
3. Feedback or “approved, next.”
4. Stay on that phase until you approve it.
5. Then the next row only.

Do not skip ahead. Do not autonomous-loop the whole product.

## What you locked

- **Who:** Agent builders, solo or teams. Product language, still easy to take in.
- **Look:** Night desk — dark, quiet, Linear/Vercel dark, not a terminal. **One chromatic:** crimson for Sign up and Approve. **Not** ochre. **Not** coral. **Not** ice. Live is a verb (Pause / Resume), not a second brand color. Dashboard has no ship color.
- **Path:** Landing → sign up → short onboarding panel → copy-paste setup prompt → **dashboard** (even if empty) → canvas only when they open a workflow or a request.
- **Canvas:** The graph is the editor. Click a node → detail panel. Drag-drop. Then Approve.
- **Approve metrics:** tokens saved, time saved, measured quality — never an `×` LLM-call ratio. Honest zeros / “not measured” until wrap records provider usage. Home does not invent these.
- **Prompt:** Default placeholders (`EDEN_API_KEY=…`). Include real env vars, and strip them. Always say when secrets are in the copied text.
- **Accounts:** Organizations from day one. **Clerk** — not a fake auth screen.
- **Empty first dashboard:** Zeros are fine. Reopen the prompt. Do not hold them until wrap connects.
- **Landing:** Instantly engaging, scroll-driven, high converting to Sign up. Direction **A** (type pins; product well rises). Phases 4–5 are animation craft on that move. **Promise only.** No fake metrics, logos, quotes, or “N teams.”

## Honesty

Allowed: tagline “Making your agents more deterministic.” Compiling repeating tools with a human Approve is the first product, not the whole story.

Forbidden: invented counts, fake customers, fake dashboards with fake numbers, feature dumps, architecture essays.

If it cannot be proven, it is not on the page.

## From Modiqo (steal the discipline, do not clone the product)

Rote’s useful idea: **keep the path that worked.** A successful run becomes an inspectable **method** (inputs, typed steps, dependencies, declared access, version) that later runs with **fresh inputs**. The path is deterministic; the world is not. Inspect the contract **before** you trust it. Fail closed. Name the broken step. Don’t embed credentials. Don’t save the chat.

Eden already has that artifact: `StretchProgram` in `packages/ir` (tool / island / loop / assert, `from` bindings, `readOnly`, version hash). Canvas, Approve, Pause, and receipts **render that**. They do not invent a Play YAML, a Play URI, or a Hub.

**Never become Rote-with-a-dashboard.** We wrap the agent they already have, compile repeating stretches into **one tool with islands**, shadow, then **human Approve**. We do not sell Reach adapters, a public commons, or local-free / team-governance SKUs.

### Steal — fold into the rows below (no parallel track)

| Take this | Put it here | Already in the tree |
|---|---|---|
| Method, not the old answer. Fresh tool results every run. | Canvas copy + Approve (22, 27). Empty Home already points at wrap, not a saved reply. | IR `returns` + runtime re-executes tools |
| Crystallize **success**: strip retries / dead ends from the reusable graph; keep them explainable, not as nodes | 22, 25 (stripped list in the panel, not extra nodes) | `packages/compile` normalize/mine |
| Inspect before ship: params, steps, **reads vs writes**, auth **declared** (never pasted), version | 25 then 27 (contract strip above crimson) | IR `readOnly`, `version` / hash |
| Fail closed on missing or invalid input. Don’t invent a value. | 26 | Compiler refuse on under-determined mutations |
| Failed step **named**; dependents **blocked**; resume from incomplete, don’t replay completed work | 28, 30 | Runtime deopt + step ids |
| Report language: skipped / degraded / failed — not a confident shrug | 30, 51 | Receipts (wire in 20a–20b, 37, 51) |
| Independent roots can run together when IR says it is safe | 23 | Loop `parallel` + `readOnly` |
| Drift is visible when the outside world moved | 28 tip + 51, not a registry | Fingerprint later; UI hole until 51 |
| Reliability is inspectability, not a “98% less reasoning” badge | 27, 30. **Never** landing. | 20b tokens / time / quality |

### Reject — do not schedule, do not “just add a screen”

- **Reach as a product** (OpenAPI / GraphQL / Discovery / “adapter from a spec”). Attach stays wrap + `wrapTools` / hooks.
- **Hub / public Play index / URI GTM** (`play.modiqo.ai/…`). Lists are workspace Requests + Workflows (19–20).
- **Credential vault**, roles, SSO-as-SKU, $99 team governance. Clerk orgs already exist (9). Keys stay opt-in placeholders (14).
- **Write-guard state machine** as a second product. Writes are visible on the contract + Approve. `readOnly` is IR, not a permission app.
- **Chat replay / OTel explorer.** Inspect is the canvas panel (25) + receipt on the same drill-in (51).
- **Landing rewrite** for handoff/reliability. Phases **1–6 are locked.** Promise only.
- Their example **98% less reasoning** (or any unproven %). Approve shows **20b** or “not measured.”

### Do not repeat work

- **Do not reopen 1–6, 7–14, or 15–20** to absorb Modiqo. Chrome, empty desk, tour, setup prompt, Clerk — done. Canvas is a drill-in under the same rail.
- **Do not build a second artifact format.** UI reads `StretchProgram`. No Play frontmatter, no `@1` product language in the chrome (internal step ids are enough).
- **Do not build inspect twice.** 25 is the contract. 50 keys the inbox off the warning. 51 is the same drill-in after a run. One language.
- **Do not swap 20a–20b for Rote’s bill.** They meter coordination; we meter compiled runs and **show** tokens/time/quality. Systems row stays 20a → 20b → canvas 21. **27 is still blocked on 20a–20b.**
- **Do not add 53+ “Modiqo phases.”** If a steal is missing, **rewrite the existing row.**

## Color

- Graphite night-desk neutrals (hue ~260, chroma ~0.01).
- **Crimson** for Sign up and Approve only — cool red, high chroma. Not ochre, not coral, not gold-portal.
- Live / ok / pause are type and copy, not a second hue. Home uses no ship color.

## Landing motion (direction A, locked)

| | Feel | Risk |
|---|------|------|
| **A — Cinematic pin** (locked) | First viewport is type. Scroll masks it away; a product well rises. | Safest conversion if type stays readable in the first 2 seconds. |

Rules: 60fps, no bounce, no particles, no gradient text, no glassmorphism stack. `prefers-reduced-motion: reduce` = static page, same Sign up path.

## Gate

**Do not start Phase 1 until you approve this list.**

After each phase: URL, what to look at, then wait.

## Phases

### Landing (1–6)

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 0 | Blank `/` — old UI deleted | (done) |
| 1 | **Hero.** Full viewport: logo, type, crimson Sign up + quieter Sign in. Static. First 2 seconds are the CTA. | I would click Sign up |
| 2 | **Scroll foundation.** Engine + motion direction (A / B / C) + a first-pass hero motion + sticky convert bar. Reduced-motion = static. Not the wow pass. | Scroll is wired; direction is locked |
| 3 | **Story.** The job (compile repeating tools; you Approve) + the path (signup → wrap → dashboard → Approve) + one product silhouette with **no fake numbers**. Content in place. Motion still first-pass. No internals. | I get it without a lecture |
| 4 | **Signature animation only.** No new copy, no new sections. Push the first-scroll move (the A/B/C trick) until it feels expensive: mask, pin, depth, timing. Iterate in the browser. 60fps. Still no bounce, particles, or gradient text. | The first scroll is the thing people remember |
| 5 | **Page choreography only.** No new copy, no new sections. Job, path, silhouette, and sticky bar move as one sequence — entrances, holds, handoffs, exit into the close. Same reduced-motion rule. | The whole page feels directed, not a stack of fades |
| 6 | **Convert + ship.** Close band, footer, landing mobile, conversion pass, a11y, no jank. | This is the front door |

Landing ends at **6**. Next row is account.

### Account (7–10)

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 7 | **Sign up** (Clerk) from the landing CTA | Account creation is real |
| 8 | **Sign in** return path | I can come back |
| 9 | **Create / join a workspace** (org from day one) | I have a workspace, even alone |
| 10 | **Routing:** logged-out → landing; logged-in → onboarding or dashboard | Auth doesn’t dump me on marketing |

### Onboarding + prompt (11–14)

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 11 | Onboarding **panel + Skip**. 3–4 beats max | I can leave |
| 12 | **Tour beats** (dashboard is home, canvas is a drill-in, crimson Approve) then land on the setup prompt. Skip lands there too | Tour ends on activation |
| 13 | **Setup prompt:** copy-paste block, placeholders by default | I know what to paste |
| 14 | **Include / strip keys** + copy + always-on secret notice | Keys are opt-in; I’m not surprised |

### Dashboard (15–20)

Chrome and empty desk are done. Lists are **compile requests and live tools**, not chat history and not a Hub. Do not reopen these rows for Modiqo inspect — that lives on the canvas.

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 15 | Logged-in **app chrome** (quiet). Dashboard route exists | I’m in the product |
| 16 | **Empty dashboard** — metric strip, 7-day chart axes, then Needs attention + Live. Not an inbox table. Not a canvas | This looks like a dashboard |
| 17 | Honest **zeros**, two empty lists (workflows \| requests), way back to the prompt | Empty is true and I know what fills in |
| 18 | Dashboard **with real data** in the same metrics | Proof isn’t wallpaper |
| 19 | **Workflows list**; click opens canvas | I can open existing work |
| 20 | **Compile requests list**; click opens canvas | I can open a request |

### Measurement (20a–20b) — required before Approve

Systems, not pixels. 27 cannot show honest numbers until these pass. Home still does not invent tokens.

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 20a | Wrap **records provider `usage`** on the chat proxy (`prompt_tokens` / `completion_tokens` onto the current run) and writes **`StretchTrace.output`**. Stop `llmCalls += 1` per tool. Tools-only wrap → “not measured”, never a fake count | (done) A real trace has tokens and an output |
| 20b | Shadow **ship gate** is tokens saved, time saved, quality (tape replay; time from remaining tool `duration_ms` on the same traces, not tape-lookup wall clock). `×` LLM-call ratio is not a gate. Vacuous output-match is not a pass | (done) A candidate is allowed into Approve on those three |

**How 20a–20b stay cheap** (do not add spend to “measure” spend):

1. **Do not run a second agent.** Naive traces are already what happened.
2. **Tools from tape.** `replayRegistry` answers every tool from the held-out trace. No extra API/write.
3. **Tokens are scraped.** The proxy already has upstream JSON; it currently drops `usage`. Zero extra model tokens. Streams: existing force-non-stream steer path, or `stream_options.include_usage`.
4. **Time is accounting on the same trace.** Tape replay finishes in microseconds — that is not compiled latency. Compiled time = sum of recorded `duration_ms` for tools the program still runs (+ island only if it ran). After go-live, receipts replace the estimate.
5. **Quality is deterministic.** Canonicalize + redact vs recorded `output`; required checks (`skipRateAfter === 0`). Island shadow still pays **one** island call if the program has an island — that is the program, not a judge. Phase 52 stays selective/cached.

Approve panel (27) shows mean deltas over held-out *n*. Missing usage → hide / “not measured”. Synthetic `200 * llmCalls` durations → do not report time saved. Ship into the panel when quality holds **and** at least one of tokens or time is measured and > 0.

### Canvas (21–27)

Same app chrome as Home (collapsible rail). Do not restyle a new shell. Graph **is** the `StretchProgram`. Exploration that compile stripped is **not** drawn as nodes.

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 21 | **Canvas well** (darker than dashboard). Back to Requests or Workflows. Not nested on `/home`. | (done) Drill-in, not a new app |
| 22 | **Nodes** are IR steps: tool / island / loop / assert, named for what they do. Chat turns and failed retries are absent. | (done) The graph looks like the method |
| 23 | **Layout** left-to-right, fit, generous space. Independent roots can sit as parallel columns when they don’t depend on each other. | (done) I can read the run |
| 24 | **Wires** are `from` bindings (step output → next input), not message edges. No spaghetti. | (done) I understand what feeds what |
| 25 | **Select a node** → **detail panel**: bindings, reads vs writes, auth **declared** (no secrets), version hash. A short “stripped from the method” list for discarded retries. Artifacts, not a transcript. | (done) I can refuse to Approve without opening logs |
| 26 | **Drag + edit** bindings in the panel. Missing/invalid input **fail closed** — the panel names the field; it does not invent a value. Mutating writes called out before they look shippable. | (done) I can change it without lying |
| 27 | **Inspect-then-Approve.** Contract strip (reads / writes / version) stays visible above the **crimson** CTA. The three numbers from **20b** (blocked on 20a–20b). Refuse siblings stay on this screen, not a second app. | (done) I know the method, the savings, and that quality held |

### Live, phone, finish (28–32)

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 28 | **Pause / Resume** on a live compiled tool. Tip shows **pinned vs live** version (hash). After a named fail, resume continues from incomplete work — completed steps stay done. No ice color. | (done) Live is a verb, and I know which program is running |
| 29 | **Mobile app:** dashboard first; canvas as a focused drill-in | (done) Phone isn’t a stacked mess |
| 30 | **Errors:** failed step **named**; downstream **blocked**; skipped vs degraded vs failed (same words as 51). What happened, what to do next. | (done) It talks like a product when it breaks |
| 31 | **A11y:** focus rings on crimson, reduced motion, skip still works | (done) It holds up |
| 32 | **Last polish** across landing + app. No new features. No Hub, no Reach, no second inspect product. | (done) This is the product |

### Waste, observability, debug (33–52)

Eden already compiles repeating tool stretches and steers later calls onto that path. [arXiv 2606.01365](https://arxiv.org/abs/2606.01365) shows most remaining waste is **mid-run**: loops, low information gain, tool-failure streaks, missing evidence, and tokens spent **after** the first warning (~58% of failed-run tokens). These rows add that layer. Honest zeros until a signal is proven. No fake token counts.

| # | What you will see | Done when you say |
|---|-------------------|-------------------|
| 33 | **Online signal bus** on wrap traces: repeated tool n-grams, fail streaks, wall/LLM budget snapshots | (done) A failing run emits cheap warnings while it is still running |
| 34 | **Information-gain score** on consecutive tool results (near-duplicate args/results) | (done) Low-gain streaks are visible, not guessed |
| 35 | **Evidence ledger** for required checks present / absent / failed before the run ends | (done) Missing evidence is a live signal, not only a shadow skip rate |
| 36 | **First-warning cursor** + cost after that point (deopt, assert fail, steered skip, tool `ok:false`) | (done) I can see the 58% post-warning spend on a real run |
| 37 | **Live receipts confirm** the 20b estimates (actual compiled tokens/`ms` vs the pre-Approve counterfactual) | (done) Post-ship numbers are measured, not only the tape estimate |
| 38 | **Usable-output flag** online (complete trace + grounded result), not only offline shadow `outputMatches` | (done) Empty-but-ok tool results don’t count as success |
| 39 | **Budget-pressure halt**: compiled-only or stop when remaining budget vs predicted stretch cost crosses a threshold | (done) The run stops spending after the warning, not at the cap |
| 40 | **Live loop breaker**: repeatingPeriod-like pattern mid-run auto-steers to the compiled program or hard-stops | (done) Loops don’t burn the rest of the budget |
| 41 | **Tool-failure streak circuit breaker** (N consecutive `ok:false` / deopts) pauses the live tool | (done) Unstable tools stop eating retries |
| 42 | **Missing-evidence redirect**: if a required check is about to be skipped, steer the compiled program or block finalize | (done) Checks aren’t optional just because the agent omitted them |
| 43 | **Post-warning kill switch** (operator override) | (done) After first warning, further LLM/tool spend is a choice |
| 44 | **Auto-pause from receipt fail rate** (today pause is manual only) | (done) Failed compiled tools don’t keep running |
| 45 | **Compile from online failure clusters** (loop / streak / low-gain spans), not only ≥3 happy traces | (done) Wasteful patterns become programs, not just refusals |
| 46 | **Mine wrap steers into `TraceEvent.skipped`** so skip-aware compile/shadow match production | (done) Skip rates are from live traffic |
| 47 | **Compile-time budget annotations** (expected `llm_calls` / `ms` / `cents`) on programs | (done) Halt can compare predicted vs actual |
| 48 | **Refuse constant/empty outputs** at compile/shadow (beyond under-determined args) | (done) “Succeeded with nothing” does not ship |
| 49 | **Cross-agent stretch compile** that collapses multi-LLM hops the paper treats as wasted coordination | (done) Multi-agent chatter can be compiled away |
| 50 | **Failure-aware inbox**: same Requests list as **20**, keyed by failure mode + first-warning offset — not a new screen, not a sequence dump | (done) Debug starts from the warning |
| 51 | **Receipt postmortem on the same drill-in as 25/27**: deopt reason, `early`, stepsRun, skipped vs degraded vs failed, drift if an external fingerprint moved | (done) I can see why it fell back without a second explorer |
| 52 | **Selective offline grounding judge** when `t.output` is absent (cached, not always-on) | (done) Weakly grounded finals are visible without a judge on every run |

## How to drive it

- Approve a phase: “approved, next”
- Reject: say what’s wrong; stay on that phase
- Change the list: **rewrite the row**; no unlisted work; no 53+ Modiqo sidecar plan
- Phase 2 direction is **A** (locked)
- Phases 4–5 add **no copy and no sections** — animation craft only
- Next **systems** row **20a–20b** is done. Canvas **21–32** is in the tree. Signal bus **33–52** is in wrap/compile/control/web. The listed rebuild is complete.
- **Roadmap Wave 20 shipped.** Landing **1–6 stay locked**. Rows **7–14** are live (account → onboarding). **15–52** stayed an in-tree review, not a second rebuild. Next product work is Wave 21 (honesty files). Wave 22 does not start until an invoice file or a soak PASS exists.
