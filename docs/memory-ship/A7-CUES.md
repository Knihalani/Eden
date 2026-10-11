# A7 — Cues: how the right memory arrives without word overlap

**Dated 2026-09-29.** Normative cue design; it specifies DECISIONS D15–D22 and A4 §5.

Evidence:
- `research/R1-cue-experiment.md` — 666 cues, 214 memories, 12 methods, cold-spawn latency, plus Addendum A on policy triggers
- `research/R2-cue-architecture.md` — cognitive science, IR, code cues
- `research/R6-real-usage.md` — what real prompts look like

---

## 1. The answer

"Not just lexical matching" does **not** mean "use embeddings". The experiment shows that when a prompt shares no words with the memory, no similarity method recovers it at an acceptable silence rate. Every method scored 0.00–0.12 recall on zero-overlap cues. That includes bge-small, MiniLM, Model2Vec, doc2query aliases and a cross-encoder (R1 §3.3). R8 re-ran it with 400 zero-overlap paraphrases written by a strong model from a different family (kimi-k3): every R1 method scores 0.000–0.048 at its tuned gate. The two partial exceptions both come from **offline** strong models:
- strong-model aliases with a τ refit recover 0.10;
- a 1B embedder at a 5% FIR budget recovers 0.32, but it collapses at strict silence and is hosted.

Both are sleep-side or experimental (§6, §9).

What works is matching on the **situation** and on **structure**:

| Layer | What it matches on | Why it works when words don't overlap | Measured |
|---|---|---|---|
| **1. Situation cue** | the prompt **plus** the previous user turn, the agent's last message, and the paths the agent just touched | "yes, do it" or "why does this redirect" share nothing with the memory, but the surrounding turn does | ctx recall **0.18 → 0.41** at no false-inject cost (R1 §0.5) |
| **2. Keys (slots)** | the cue is mapped to a *slot* (`pkg.manager`, `auth.provider`, …) by a small detector; the slot is looked up directly | "install deps" never says "pnpm"; it does say "install" → `pkg.manager` | design (R2 §6.1b); seed lexicon, sleep-trained later |
| **3. Compiled triggers** | a policy compiles to **action classes**; an action word in the cue fires it | "looks done, can you land it?" shares nothing with "never merge PRs yourself", but *land* ∈ integrate | policy recall **0.47** at 4% FIR on negatives, vs ≤ 0.22 for similarity at 5–15% FIR (R1 Addendum A). **On unseen phrasings (R8): 0.18 (0.26 of reachable) at 10% FIR**; similarity scored 0.000. So the lexicon must grow from misses (§6), and the command-level guard (layer 4) is the primary policy channel. Cost: 19% of non-policy positives gain a policy bullet. The ledger's 400 KB refractory and the ≤ 2-per-class cap keep this under the G3 target, so the A5 `policy-trigger` arm reports `false_rate` on non-policy positives too |
| **4. Action-time cues** | the agent's own **tool actions**: the command it is about to run, the file it just opened, the error it just hit | the most focal cue there is. `gh pr merge` *is* the merge; `ERR_REQUIRE_ESM` *is* the error | PreToolUse `if`, PostToolBatch, PostToolUseFailure (R0) |
| **5. Learned bridges** | aliases written offline on the memory side: (a) a strong model's blind candidates (opt-in NIM gemma-4-31b), kept or dropped **as a batch** after a τ refit; (b) class words and jargon from **misses** | the bridge vocabulary is built offline from what users type, and gated by silence | weak-model doc2query failed (R1); strong-model batch + τ refit: held-out paraphrases **0.102 vs 0.000** at lower FIR (R8 E2); per-alias acceptance does **not** control silence (1,612/1,639 passed, +92 fires together) |
| **6. Similarity (lexical BM25F)** | word overlap, weighted by field and rarity, behind a per-repo calibrated gate | handles the ~70% of cues that do share a rare token | recall 0.58, silence 0.85 vs today's 0.52 / 0.50 (R1 §3.1) |
| *7. Dense similarity (experiment)* | a ≥ 1B embedder served warm, as a **separate** gate (never an RRF union), with a cross-encoder veto | ranks the gold top-4 for 70% of zero-overlap paraphrases (ungated) | nemotron-embed-1b: +0.14 recall@4 at half BM25F_ctx's FIR (5% point), 0.32 of zero-overlap paraphrases; **0.003 at strict silence**; hosted 0.4–1 s. bge-small: +0.01, so dropped as the candidate (R8 E5) |

Layers 1–4 are how biological recall mostly works (A3, R2 §1). Recall is **context-dependent** (encoding specificity, place and event cues) and **cue-driven** (prospective memory fires when the focal cue appears). It is not a similarity search over everything ever stored. Involuntary memories, the model for silent injection, are triggered by *distinctive* features of the current situation (Berntsen, R2 §1.4).

---

## 2. Turn mode (rules first; trained later)

| Mode | Detector (v1 rules) | Effect |
|---|---|---|
| `nonhuman` | first non-space characters are `<task-notification`, `<agent-message`, `<cross-session-message` or `<teammate-message`, **or** the text equals a `session_crons[].prompt` from the window's last Stop payload. The payload has no origin field | silence, except `Updated:` items (DECISIONS D24) |
| `ack` | ≤ 3 tokens from {ok, thanks, cool, nice, great, got it, sounds good}; **or** {continue, keep going, next, go on} when the previous assistant message is **not** a proposal (no trailing `?`, no `shall I / want me to / should I / next I'll / I can`) | silence unless an open error or intent trigger fires |
| `continuation` | {yes, do it, go ahead, proceed}, or {continue, …} / ≤ 4 content tokens **after an assistant proposal** | cue weight moves to `q_prev`; injects only on **STRONG** evidence from `q_prev` (identifier-shaped token or keyed slot hit). MEDIUM from `q_prev` alone never admits |
| `debug` | error-shaped text, "failing", "broken", "error", stack-trace lines | adds the gotcha lane |
| `how-to` | "how do I", "how to", "run the tests", "set up" | adds the procedure lane |
| `question` | ends with `?` or starts with a WH-word | normal |
| `imperative` | default | normal |

R6: 13% of prompts are `continue` (34% in Eden sessions), and 63% of submits are non-human. Whether a "continue" is `ack` or `continuation` depends on the previous assistant message, so the same prompt can be silent (after a report) or a C1 recall case (after a proposal).

---

## 3. The cue (situation vector)

```
q_prompt = identifier-split, stopworded tokens of the prompt           (paths, camelCase, snake, kebab split)
q_turn   = same for the previous USER turn in this window               (R1 M7)
q_path   = basename + non-generic dir segments of recent paths (ctx.log) (R1 M7)
q_prev   = rare tokens of last_assistant_message (qprev.json, written by sync stop-fast; rebuilt from the transcript tail after an interrupt), minus tokens of bullets Eden delivered last turn

weights by mode       q_prompt  q_turn  q_path  q_prev
default                 0.55     0.15    0.15    0.15
continuation            0.15     0.15    0.20    0.50
debug                   0.45     0.10    0.20    0.25
```

- Each part is scored separately against each candidate (BM25F), and the parts are summed with these weights.
- The gate sees the per-part scores as well as the sum. A long busy context therefore cannot make everything look relevant: per-part mass limits prevent it (R2 §5.2).
- There is **no query-side synonym expansion** and no pseudo-relevance feedback. Both amplify a wrong top-1, which is the silence failure.

---

## 4. Evidence classes and the gate

This revises R2 §7.4 using R1's calibration. R1 found that 90 of 150 negatives **contain** a df ≤ 5 word ("docker", "tailwind"), so a rule admitting on one rare word would fire on them. Rare words alone are not STRONG.

| Class | Evidence |
|---|---|
| **STRONG** (admits alone) | keyed slot hit (detector ≥ θ_slot **and** a live value in the read set) · compiled trigger hit (action class → policy/intent) · error-signature match · **identifier-shaped** token match: path, filename with extension, `ERR_*`/`E\d+` code, CLI flag, version string, id with digits+letters, symbol with internal case/underscore |
| **MEDIUM** | a rare plain word (df ≤ 50) matched in `q_prompt` · a match via `q_prev`, `q_turn` or `q_path` · a matured alias |
| **WEAK** (ranks only) | common words, immature aliases, dense cosine (daemon) |

**Admission:**
- Admit a slot, policy, intent, gotcha or procedure on **1 STRONG**, or when the BM25F sum ≥ **τ_repo** (then keep rows ≥ 0.7·top).
- Admit an episode only on 1 STRONG, or on MEDIUM from **≥ 2 different cue parts**, **and** BM25F ≥ τ_repo.
- WEAK evidence never admits.
- In the daemon, a dense-only admission needs cos ≥ 0.72, a margin of 0.04 over the second candidate, and **no cross-encoder veto** (D20).

**τ_repo calibration** (heavy sleep):
- Replay the silence set and pick the smallest τ that keeps it silent. The silence set is:
  - seed hard negatives (the R1 negative classes: chat, math, off-topic coding, hard lexical traps)
  - this repo's logged human prompts on which the **pre-gate candidate set was empty** (no row shared a MEDIUM+ token), plus prompts in `ack` mode. Use labels are **not** used here (A4 §8)
  - never fewer than 300 prompts, **pooled across the user's repos (idf-rescaled)**, before τ is trusted; until then use the R1 strict point (4.1 on the fixture scale, rescaled by the repo's mean idf)
- Then check gold recall on the repo's annotated cues. If recall drops by more than 0.05, keep the old τ and flag it.

R1 measured that lexical thresholds transfer poorly: dev FIR 0 became test FIR 7.5%. So τ is always per repo, always refit, and always reported.

---

## 5. Triggers (compiled at write and at sleep)

```jsonc
{ "id": "01J9…(ULID)", "kind": "policy", "scope": "", "text": "...",
  "rule_key": "integrate|neg|*",           // (class, polarity, object), D9; cid = <repo8>/P:<hash(rule_key)>
  "classes": ["integrate"],
  "refine_if": ["gh pr merge*"],           // optional: narrows (never widens) the shipped class patterns
  "irreversible": true }
```

**Action-class lexicon.** It ships as data (`classes.json`) and is extended by D21 miss-driven learning.

| Class | Words |
|---|---|
| integrate | merge, land, ship, get it in, close out, finish up, wrap up |
| review | PR, pull request, review, put up |
| complete | done, finished, good to go, ready, all set |
| commit | commit, sync |
| push-upstream | push, push to origin/remote, upload the branch |
| branch | branch, main, master, checkout |
| history-rewrite | squash, rebase, amend, force-push |
| deploy | deploy, release, prod, publish, roll out |
| delete | delete, remove, rm, clean up, prune, drop |
| dependency | add dep/package/library, install, npm i, pnpm add, bump, upgrade |
| destructive-db | drop/truncate/reset/wipe + db/table/schema |
| generated | dist/, `.gen.ts`, generated |
| billing | billing, invoice, payment, stripe |

Topical words (tests, docs, logs, explain) are **not** trigger classes; they overfire (39% FIR, R1 Addendum A).

**PreToolUse `if` map** (class → commands):

| Class | Commands |
|---|---|
| integrate | `git merge*`, `gh pr merge*`; plus a tool-name matcher `mcp__.*__merge.*` (no `if`) |
| review | `gh pr create*` |
| commit | `git commit*` |
| push-upstream | `git push*`, `gh pr merge --auto*` |
| history-rewrite | `git push --force*`, `git push -f*`, `git push *+*`, `git rebase*`, `git commit --amend*` |
| deploy | `*deploy*`, `vercel*`, `fly deploy*`, `kubectl apply*` |
| delete | `rm -rf*`, `rm -fr*`, `rm -r*`, `git branch -D*`, `git push * --delete*` |
| dependency | `npm i*`, `pnpm add*`, `yarn add*`, `bun add*`, `pip install*`, `cargo add*` |
| destructive-db | `*migrate reset*`, `*db drop*`, `psql*DROP*` |

**Registration (static).**
- `hooks.json` ships one PreToolUse handler per `(class, pattern)` of this map. Each `if` holds exactly one permission rule (R0 F23), so the map is about 25 handlers.
- The handlers use exec form, with the class passed as an argument (`"args": ["${CLAUDE_PLUGIN_ROOT}/scripts/guard.ts", "--class", "integrate"]`).
- The map is a static superset:
  - Per-policy `refine_if` and user-defined classes **refine inside the guard**: they narrow, and never widen, what a shipped pattern catches.
  - A user-defined class whose commands fall outside the shipped patterns is delivered only by the prompt-side trigger and at PostToolBatch.
- The guard **re-checks** `tool_input.command` against its class, because `if` is best-effort: it also spawns on commands with `$()` or `$VAR`.
- **Dedup across parallel handlers.** Each process takes `flock(windows/<win>/guard.lock)` and appends `{tool_use_id, class}` to `guard.log`. The most severe class for a `tool_use_id` emits; the rest exit `{}`. Severity order: history-rewrite > delete > destructive-db > deploy > push-upstream > integrate > others.
- **Lookup.** `dirmap.json` gives the repo in < 1 ms. The guard then reads `policies.jsonl`, `intents.jsonl` and `_user/policies.jsonl` filtered by class; each is < 64 KB (cap: 500 live rows per repo).

**Per-class cap and order.** When a class fires on the cue, deliver at most 2 of its policies, ranked by:
1. user-stated
2. most recently stated
3. narrowest scope

The ledger then keeps each one to once per 400 KB of context.

---

## 6. Learning bridges (sleep; D21)

1. **Miss capture.** Every `restate` classified `not_retrieved` (A4 §7) records the **cue that preceded it**, meaning the prompt where the memory should have fired.
2. **Proposal.** Candidate bridges are the content tokens of that cue (df ≤ D_rank, not stopwords, ≤ 3 per event) → aliases on the row, or new words for a trigger class.
3. **Acceptance.** Keep a candidate only if **≥ 2 independent misses** propose it, replaying the last 500 logged cues gives ≤ 1 new fire outside those misses, **and** the row holds ≤ 8 accepted aliases.
4. **Expiry.** An accepted alias that produces 3 `ignored` and 0 `used` deliveries is removed.
5. **Blind strong-model batch** (opt-in, `sleep.llm`; gemma-4-31b via NIM, D21a):
   - ≤ 8 raw aliases per row, **no df cap** (the cap removes the bridging user words like "install" or "cleanup").
   - The whole batch is kept only if, after a τ refit, silence-replay FIR ≤ the pre-batch FIR and annotated recall drops by ≤ 0.02.
   - Per-alias replay alone is not a valid test.
6. **Miss-driven path** (steps 1–4): used for **action-class words and repo jargon**. On the fixture it accepted only generic tokens and moved no held-out cue (R8 E2b), so it is not the main alias source.

This is affinity maturation (A3 §3.14): generate candidates from real failures, select them against a silence set, keep the survivors.

---

## 7. What fixes which kind of zero-overlap miss

The categories come from R2 §8.1, extended with R6's classes. Measured rows cite R1; the rest are design expectations to verify with the A5 arms.

| Category | Example | Mechanism | Status |
|---|---|---|---|
| C1 continuation | "yes do it" | `q_prev` (layer 1) | design; R6 says 13% of prompts |
| C2 place-only | a bare prompt after editing a file | `q_path` + PostToolBatch (layers 1, 4) | **measured**: ctx recall 0.41 vs 0.18 |
| C3 event | an error seen before | error signature → gotcha (layer 4) | design |
| C4 slot synonym | "install deps" ↔ pnpm | slot detector (layer 2) + learned bridges | design |
| C5 encoding context | "set up the db" ↔ a memory written after `docker compose up pg` | `enc_cues` on rows (R2 §1.1) | earn-in (DECISIONS §7) |
| C6 cross-file | editing an API route ↔ a note about the client hook | co-change graph | earn-in |
| C7 true paraphrase | "why is sign-in slow" ↔ "Clerk session fetch adds 400 ms" | strong-model alias batch (opt-in); dense arm experiment | **measured**: lexical/small dense ≤ 0.05 on strong paraphrases; gemma aliases + τ refit 0.10; nemotron-embed-1b 0.32 at 5% FIR (experiment only) |
| **P policy** | "looks done, land it" ↔ "never merge yourself" | guard at the command (primary) + compiled triggers (layers 3, 4) | **measured**: prompt trigger 0.47 on seen phrasing, **0.18 on unseen**; similarity ≤ 0.22 / 0.000 |
| **I indirect need** | "set up on a new laptop" ↔ pkg manager, node version, env | slot bundles: `setup` → {pkg.manager, node.version, env location} | design; all methods measured ≤ 0.07 |

---

## 8. Latency (fresh process; budget 150 ms)

| Step | Cost | Source |
|---|---|---|
| Bun start + imports | 10–25 ms | R1 §4, A2 §1 |
| read `ctx.log` (fold ≤ 16 KB), `qprev.json`, `delivery.json` + `delivery.log` (≤ 32 KB), `tau.json`, `shadow.log` and the files it names (about 0.95 ms p50 for a 10 KB CLAUDE.md and MEMORY.md, 4.7 ms at P1.3's 64 KB cap) | < 3 ms | — |
| mode + slot detector + class match | < 1 ms | regex / linear |
| BM25F over scoped postings, ≤ 20k rows in memory | 5.5 ms warm-equivalent; building the index in-process at 20k costs ~100 ms | R1 §4. **So a prebuilt on-disk index is required above ~5k rows** (JSONL postings snapshot at sleep, or SQLite FTS at P6, ~25 ms; an estimate, not measured, R1 §7) |
| residual (≤ 256 KB parse) | ≤ 10 ms | estimate |
| emit + log append | < 1 ms | — |

- The PreToolUse guard runs on `if`-matched commands **and** on commands Claude Code cannot parse (`$()`, `$VAR`): startup, a `dirmap.json` read, and ≤ 3 small file reads.
- PostToolBatch: startup plus the ctx update, under 30 ms.

---

## 9. Re-open conditions

| Change | Re-open when |
|---|---|
| Dense on the hot path | a ≥ 1B embedder **served warm within the Submit budget** beats BM25F + context by > 0.05 recall@4 at equal FIR on ≥ 300 real hard negatives (D15, revised by R8) |
| LLM prediction at Stop | continuation misses ≥ 10% of logged misses after C1 ships |
| Graph / co-change cues | C6 ≥ 10% of logged misses |
