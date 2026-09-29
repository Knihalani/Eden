# Appendix A3 — Nature's memory mechanisms, turned into Eden specs

> **Precedence note (v2, 2026-09-29):** [DECISIONS.md](DECISIONS.md) and [A4 v2](A4-DELIVERY-CONTRACT.md) supersede this appendix wherever they differ. Examples: the ledger is per context window, `resume` never resets it, scope follows R5 §9, and only slot facts supersede by key.

**Dated 2026-09-29.** Part of the memory-ship set; the index is `ROADMAP.md`. This appendix supplies the rationale. `A4-DELIVERY-CONTRACT.md` is the normative design, and **A4 decides** where they differ. In particular, A4 §9 proposes lock changes, including repo-keyed memory and cascading scope, that this appendix predates. Locks held here: no LLM or embeddings on Submit, a 6-bullet / 900 B packet, supersession within `(scope,s,p)`, and fail-open.

This appendix asks one question: **which mechanisms make biological memory efficient, and what exact data field, formula, or threshold does each become in Eden?** Anything that cannot be turned into a field, a formula, and a test is marked as decoration and dropped.

**Citation status.** Every neuroscience or psychology DOI in §R was checked against the Crossref API on 2026-09-29, including the first author, year, volume, and pages. Machine-learning arXiv IDs were originally from memory; all were re-checked against the arXiv API in the 2026-09-29 citation audit (`research/R4-citation-audit.md`) and exist with matching title and authors, and every DOI in §R was re-resolved on Crossref the same day. Two numbers in the body are my own proposals, not literature values, and are flagged **[tunable]**.

---

## 0. The user's five goals, as metrics

Every mechanism below is scored against these. Each goal gets a name and a metric so a benchmark can check it.

| # | Goal | Failure name | Metric (per turn, computed from the hook log + transcript) |
|---|---|---|---|
| G1 | The user never restates anything | **Miss** | `restate_rate` = user turns that re-assert a fact Eden already held live in the matching scope, divided by user turns. Detect this in sleep: a copula written this turn whose `(scope,s,p,o)` already existed live **before** the turn. |
| G2 | Stale memory never drags the agent down | **Stale inject** | `stale_rate` = injected bullets whose `(scope,s,p)` was superseded before the injection timestamp. The target is 0; it is a hard invariant. |
| G3 | Irrelevant memory never drags the agent down | **False inject** | `false_rate` = bullets with no lexical or scope link to the next 3 agent actions (tool paths, edited symbols, answer text). Judge this offline in sleep. |
| G4 | Inject directly and efficiently | **Waste** | bytes injected per *useful* bullet; p95 Submit latency (already acceptable) |
| G5 | Nothing repeated unnecessarily | **Redundant inject** | `redundant_rate` = bullets whose exact content id was already delivered within this session's live context window (not yet compacted) and whose source has not changed since |

Today's Eden handles G3 well (silence works) and G1 poorly once the store holds more than about 2k rows, as the long-horizon exam showed. G5 is **not measured at all**: the hook process is fresh on every Submit and has no memory of what it injected last turn. That is the single largest gap this appendix finds. Biology's most basic filter, habituation, is missing.

---

## 1. Critique of the existing "biology" framing in `docs/MEMORY-PLAN.md`

The plan's §1–§2 maps Eden onto the medial temporal lobe plus sleep, following CLS (McClelland, McNaughton & O'Reilly 1995). The skeleton is right: a fast episodic store, a slow semantic store, and offline consolidation. The problems are in what it leaves out and in a few analogies that mislead.

1. **It models storage and consolidation, but not delivery.** Every row of the plan's §2 table is about *what gets stored where*. Biology spends at least as much machinery on *not re-presenting* what the system already holds: habituation, repetition suppression, inhibition of return, predictive cancellation. Eden's user goals G2, G3 and G5 are delivery goals. The plan has no entry for them. "Silent inject" covers G3 only through lexical silence.
2. **"Store-all at the hippocampus" is presented as biology, and it is not.** The hippocampus does not store everything equally. Encoding strength is gated by novelty and prediction error (Lisman & Grace 2005; Ranganath & Rainer 2003), by neuromodulators (McGaugh 2004), and by expected future relevance (Wilhelm et al. 2011). *Keeping* raw turns forever is a sound **engineering** choice, because disk is cheap and a log is the source of truth. But the retrievable **index weight** should be gated. The plan conflates the diary, which is lossless, with the engram, which is weighted.
3. **"Pattern completion from a fragment" is claimed for a lexical rarest-token union.** CA3 completion is attractor dynamics over a sparse, **pattern-separated** code (Treves & Rolls 1994). Eden has neither separation (one global `(s,p)`) nor completion (only token overlap). The long-horizon failure, where web Clerk and cli `none` collide, is precisely a **pattern-separation failure**. The plan names the dentate gyrus but never builds the orthogonalizing key. `(scope,s,p)` in P1 is the actual dentate gyrus. Call it that and test it as such.
4. **Salience is described as a tag "for sleep", but nothing reads it at Submit.** The plan's own history shows the problem: `sal=0.6` was not pinned. In biology, neuromodulation changes **both** encoding gain and later retrieval priority (Mather & Sutherland 2011). One field has to feed two formulas, or it is a comment.
5. **Forgetting is treated as decay plus tombstones.** Biology separates at least four kinds: (a) supersession or reconsolidation, where a new value replaces the old (Nader et al. 2000; Lee et al. 2017); (b) interference and retrieval-induced forgetting, where competitors are suppressed when one wins (Anderson et al. 1994; Wimber et al. 2015); (c) active, intrinsic forgetting, a regulated clearing process (Shuai et al. 2010; Berry et al. 2012; Davis & Zhong 2017); and (d) rational decay, where need-probability tracks environmental statistics (Anderson & Schooler 1991). Only (a) is in Eden. (d) is the best-supported formula in the whole literature for "what will be needed next", and Eden does not use it.
6. **"Place / grid (entorhinal)" is described as an optional key.** In rodents, context is not an optional key. It **remaps** the whole code (Colgin, Moser & Moser 2008). The lock in EDEN-MEMORY §11 (scope on the row, exact-scope copulas, pins inherit) is closer to real remapping than the plan's "optional keys when the host has them". Adopt the lock's framing.
7. **Prospective memory is listed as a "silent trade (accepted)".** This is correct about interrupts. But prospective memory in humans is **mostly cue-driven and spontaneous** (McDaniel & Einstein 2000). It works through exactly the channel Eden has: a cue appears and the intention pops out. So cue-triggered intentions are *not* a trade-off. They are a missing store (§3.15).
8. **Working memory is described as a session buffer.** Cowan (2001) gives a **capacity** of about 4 chunks. Eden's packet is 6 bullets, and a scalar byte cap is not a chunk cap. The packet should be justified in chunks (§3.12).
9. **Sleep is framed as "replay into schemas".** The strongest sleep findings are about **selection**, not compression. Sleep preferentially consolidates what is tagged as future-relevant (Wilhelm et al. 2011), emotionally salient, or schema-consistent, and downscales the rest (Stickgold & Walker 2013; Tononi & Cirelli 2014). Eden's sleep should be a **triage** job with explicit selection formulas (§3.6).

Net: keep CLS as the architecture. Add the **delivery layer** (habituation, IOR, prediction cancellation, lateral inhibition), a **rational activation formula** in place of ad-hoc kind boosts, and **selection in sleep**.

---

## 2. What Eden must know at Submit that it does not know today

Most mechanisms below need one new small file, written by the hook and read by the next hook process:

```
<root>/<session>/delivery.json      (≤ 8 KB, atomic rewrite, 0o600)
{
  "ctx_epoch": 3,                 // bumps on PreCompact / SessionStart / clear / scope change
  "turn": 118,                    // Submit counter for this session
  "scope": "apps/web",            // last cue scope
  "delivered": {                  // content id -> last delivery
     "c:apps/web|auth|provider": {"turn":112,"epoch":3,"ver":"h:9f2c","n":2},
     "p:env-commit":             {"turn":101,"epoch":3,"ver":"h:11aa","n":5}
  },
  "suppressed_by_user": { "p:env-commit": 118 },   // "stop telling me X"
  "hab": { "p:env-commit": 0.62 }                    // habituation strength per item
}
```

`ver` is a short hash of the rendered bullet text. Items are keyed by **content id**, never by row id, so the same fact reached through two rows habituates once. This file is the agent's **short-term adaptation state**. It is intentionally separate from long-term memory, just as sensory adaptation is separate from the engram.

---
## 3. Mechanisms

Each mechanism uses the same six fields: **Bio**, **Principle**, **Eden spec** (fields, formula, thresholds, and where it runs: *encode* = observe/remember, *Submit* = hook hot path, *sleep* = offline), **Serves**, **Risks**, **Test**.

### 3.1 Habituation, repetition suppression, sensory adaptation → the refractory ledger

**Bio.** Habituation is the decrement in response to a repeated stimulus that carries no new consequence. It is stimulus-specific, recovers spontaneously with time, and is reversed at once by a novel stimulus (**dishabituation**). This set of parametric properties was catalogued by Thompson & Spencer (1966) and revised by Rankin et al. (2009). In cortex, **repetition suppression** is the reduced neural response to a repeated stimulus (Grill-Spector, Henson & Martin 2006; Desimone 1996). Summerfield et al. (2008) showed it is modulated by *expectation*: suppression is larger when repetition is expected, so it is partly prediction, not just fatigue. Stimulus-specific adaptation in auditory cortex responds to rare tones and adapts to common ones (Ulanovsky, Las & Nelken 2003).

**Principle.** Re-presenting an unchanged signal to a system that has already registered it costs bandwidth and adds nothing. Response gain for a specific item should fall with each unchanged repetition, recover with time, and reset on a context change or a change in the item.

**Eden spec.**
- Content id: `cid = kind + ":" + scope + "|" + s + "|" + p` for copulas; `"p:" + normalizedTextHash` for pins, rules and procedures; `"e:" + id` for episodes. Version `ver = hash(renderedBullet)`.
- **Submit**, after ranking and before packing:
  ```
  d = delivered[cid]
  inWindow = d && d.epoch == ctx_epoch && d.ver == ver
  if inWindow and (turn - d.turn) < R_kind: drop bullet            // refractory period
  ```
  where `R_kind` is `∞` within the epoch for copulas and procedures (the value is still in the context window, so delivering it once is enough) and `R = 20` turns for pins and rules **[tunable]**. Pins get a finite refractory period because long contexts dilute early tokens: models use mid-context information poorly (Liu et al. 2024, "Lost in the Middle"). A constraint that must bind this turn may need re-surfacing, but not every turn.
- **Dishabituation.** Any of the following resets the cid, or all cids:
  1. `PreCompact`, `SessionStart`, `/clear`, or a resumed session: `ctx_epoch++`, which resets all.
  2. The cue scope changes (`apps/web` → `packages/cli`): no global reset, but items whose scope differs are naturally re-eligible, and items with a new relevance context get a fresh chance.
  3. The item's `ver` changes, meaning the fact was updated. This *must* inject; it is the most valuable bullet there is.
  4. A **violation signal**: the agent's last tool action touched the item's subject in a way that contradicts it (for example, the rule says never commit `.env` and the last PostToolUse contains `git add .env`). In that case, re-inject regardless of refractory state. This is the "novel consequence" arm of dishabituation.
- **Encode**: after the packet is emitted, write `delivered[cid] = {turn, epoch, ver, n+1}`. The write is O(bullets) and atomic.

**Serves.** G5 directly. G4, because bytes go only to novel bullets. It also indirectly frees packet slots for items that would otherwise be crowded out, which helps G1.

**Risks.** (a) Host compaction without a PreCompact hook: the item has left the window but the ledger thinks it is still present, so it never re-injects. Mitigation: epoch also bumps when the transcript byte length **decreases**, or when the turn count since the last epoch exceeds a ceiling of 60 turns **[tunable]**. (b) A subagent or child session has a *different* context window, so the ledger is keyed per session file, never shared with the parent. (c) The analogy breaks because biological habituation is automatic and graded, while here it is a hard gate. A hard gate is correct for G5 but must fail open: if the ledger read throws, inject as today.

**Test.** Hook fixture: the same cue three times in one session gives exactly 1 packet, then empty, then empty. Update the fact between calls 2 and 3, and call 3 injects the new value. PreCompact between 2 and 3 makes call 3 inject again. A child session injects on its own first cue. Report `redundant_rate` before and after on the live coding holdout. Expected: redundant bytes fall sharply, with `restate_rate` unchanged.

### 3.2 Predictive coding, prediction-error-gated encoding, novelty

**Bio.** Predictive coding theories hold that cortex transmits mainly the **residual** between predicted and actual input (Rao & Ballard 1999; Friston 2005). Midbrain dopamine neurons signal reward prediction error, not reward (Schultz, Dayan & Montague 1997). The hippocampus–VTA loop proposes that hippocampal novelty/mismatch detection triggers dopamine, which gates LTP, so novel information enters long-term memory preferentially (Lisman & Grace 2005). Greve et al. (2017) directly tested whether prediction error drives one-shot declarative learning in humans and found **mixed** support. The effect is real but not universal. The honest reading is that prediction error modulates encoding strength rather than being required for it.

**Principle.** Two separate uses. (1) **Encode**: weight a write by how surprising it is relative to what memory already predicts. (2) **Deliver**: do not inject what the receiver can already predict from what it already has.

**Eden spec.**
- **Encode** (copula write `(scope,s,p,o)`): compute a prediction-error class against the live table:
  | Case | PE | Action |
  |---|---|---|
  | No live row for `(scope,s,p)` | novel, `pe=1.0` | insert; `gain=1.0` |
  | Live `o` equal | none, `pe=0` | **do not** insert a new row. Increment `reps`, append the timestamp to `uses[]` (this is ACT-R practice, §3.9), and log a `restate` event (which feeds the G1 metric) |
  | Live `o` differs | contradiction, `pe=1.0` | supersede (§3.7); tag `corrected=1`; neuromodulator gain (§3.11) |
  | Live row exists only in an **ancestor** scope with a different `o` | override, `pe=0.7` | insert in the child scope; do not touch the parent |
- **Deliver** (Submit): an item is **predictable from context** when it is already inside the prompt the agent will see. Cheap check: if every content token of the rendered bullet's object (e.g. `clerk`) *and* the subject appear in the current user prompt, drop the bullet, because the user just said it. The same applies to open-file paths the hook received: a `[episode] … src/auth.test.ts` bullet adds nothing if `src/auth.test.ts` is the open file *and* the bullet has no other content token. The rule is to inject only a **residual**.
- **Sleep**: a `restate` event is the most direct G1 failure signal there is. It means the user said something Eden already knew, so either Eden failed to inject it earlier or the user is confirming it. Sleep joins `restate` events against `delivered` to split the two cases. *Restated and not delivered in the previous N turns* goes to `miss.jsonl` with the cue that should have hit it. Sleep then writes aliases from that cue's tokens onto the row (P6 `WRITE_ALIASES`), which is **learning from the miss**, a prediction-error update on retrieval.

**Serves.** G1 (the miss loop), G5 (don't echo the prompt), and G4.

**Risks.** "The agent can predict it" cannot be measured without a model call, since the LLM's prior is invisible. Only the *context-contained* part of prediction is checkable at Submit. Do not pretend otherwise. Over-dropping: the user writes "is auth still Clerk?" and the bullet is dropped because `clerk` is in the prompt. A question is precisely when the answer bullet is useful. Mitigation: the predictability drop applies only to **non-WH, non-question** cues, using the existing WH detector.

**Test.** Unit: a copula write of an unchanged value creates 0 new rows and `reps` increments. A prompt "auth is Clerk, fix login" yields no `auth.provider = Clerk` bullet. A prompt "is auth still Clerk?" does inject it. Sleep: seed 20 restates, and `miss.jsonl` contains the non-delivered ones. After alias healing, the same cue injects.

### 3.3 Inhibition of return, lateral inhibition, winner-take-all → packet diversity

**Bio.** **Inhibition of return (IOR)**: after attention leaves a location, returning to it is slowed for roughly 300 ms to 3 s. This biases search toward new locations (Posner & Cohen 1984; Posner et al. 1985; review Klein 2000). **Lateral inhibition**: neighbouring receptors suppress one another, sharpening contrast (Hartline, Wagner & Ratliff 1956). In the fly mushroom body, a single inhibitory neuron (APL) implements global feedback inhibition, so only about 5–10% of Kenyon cells fire. This sparse, decorrelated code improves odour discrimination (Lin et al. 2014). Winner-take-all circuits are computationally powerful primitives (Maass 2000).

**Principle.** A selected item should suppress (a) re-selection of itself across time (IOR, which is §3.1's temporal twin) and (b) selection of its near-duplicates at the same moment (lateral inhibition). The IR equivalent is **maximal marginal relevance** (Carbonell & Goldstein 1998).

**Eden spec** (Submit, after scoring, before packing):
```
selected = []
for x in candidates sorted by score desc:
   sim = max over y in selected of J(x,y)     # J = Jaccard on content-token sets,
                                              # or FlyHash overlap (§3.10)
   if same (scope,s,p) as any y: continue      # hard WTA per key: one value per slot
   if sim >= 0.6: continue                     # near-dup inhibition (existing M39 threshold)
   adj = score(x) * (1 - 0.5*sim)              # soft lateral inhibition
   selected.append(x) if adj >= θ_floor
   stop at 6 bullets / 900 B
```
Plus **kind quotas** (winner-take-all per pool): at most 1 procedure, at most 2 episodes, and at most 1 bullet per `(s)` subject unless the cue names two predicates. These are already stated in EDEN-MEMORY §10 ("at most one procedure, at most one episode"); this spec makes them a formula.

**Serves.** G3 and G5 (no three bullets saying the same thing), and G4.

**Risks.** Jaccard over short bullets is noisy. Two correct distinct facts ("auth = Clerk", "auth callback = /api/clerk") share tokens and may inhibit each other. Mitigation: never inhibit across different `(s,p)` keys by Jaccard alone; require `sim ≥ 0.8` in that case. The biology analogy breaks in one respect: IOR in vision is transient and spatial, whereas here the "space" is the content-id space. That is fine: the computational role is the same.

**Test.** Seed 5 paraphrases of the Clerk fact across episodes plus the copula. The packet contains exactly 1 Clerk bullet (the copula, since it is the higher kind). Two distinct predicates on `auth` both appear when the cue names both. Measure the packet's mean pairwise Jaccard on the holdout; the target is < 0.25.

### 3.4 Pattern separation (dentate gyrus) and pattern completion (CA3)

**Bio.** The dentate gyrus orthogonalizes similar inputs into dissimilar codes. CA3 recurrent collaterals complete a stored pattern from a partial cue (Treves & Rolls 1994). Leutgeb et al. (2007) recorded both in rats: DG units changed firing with small environmental changes, whereas CA3 switched to a new code only for larger ones. Review: Yassa & Stark (2011). The hippocampal **indexing** theory says the hippocampus stores a sparse *index* that points to neocortical content, rather than the content itself (Teyler & DiScenna 1986).

**Principle.** Separation is needed wherever two contexts would otherwise **overwrite** each other's values. Completion is needed wherever a partial cue must reach the whole record. They trade off: more separation means less generalization.

**Eden spec.**
- **Separation = the key.** `(scope, s, p)` from P1 is the DG. Its job is to make `apps/web|auth|provider` and `packages/cli|auth|provider` orthogonal. Write-time rule: stamp scope from the collapsed product folder (EDEN-MEMORY §11). **Pins/rules** are generalizers and inherit down. **Copulas** are separated and exact-scope. That is the DG/CA3 trade-off expressed as a per-kind flag: `inherit: bool` defaults to `true` for kinds `rule|constraint|pin` and `false` for `fact`.
- **Separation of near-identical episodes**: episodes are append-only and never merged at encode (DG orthogonalizes). Sleep may merge them into a gist (CA1/neocortex).
- **Completion = the index.** Submit: a partial cue (`clerk`, `callback`, or even just an open file in `apps/web`) resolves to the whole record via (1) subject parse → keyed lookup `get(scope, s, *)`, and (2) a token → cid posting (scoped). This is indexing theory: the hot path reads *pointers*, and the record is hydrated only for the ≤ 64 winners (already the P5b plan).
- **Scope-level completion without any token**: when the cue has an open-file scope but no content tokens overlap (e.g. "fix the login bug"), completion falls back to **context-only priming** (§3.13): inject nothing, or at most one pointer.

**Serves.** G2 (no cross-folder stale value) and G1 (partial-cue reach).

**Risks.** Over-separation: the user states a repo-wide fact while a file in `apps/web` is open, and it is stamped `apps/web` only, so `packages/cli` misses it and the user restates it (a G1 failure). Mitigation: the restate detector in §3.2. If the same `(s,p,o)` is asserted in ≥ 2 sibling scopes, sleep **promotes** it to their common ancestor with `inherit=true` and tombstones the children. That is systems-level generalization after separation: the analogue of the Tse schema effect, §3.6. Conversely, if an ancestor value is overridden in ≥ 1 child, keep the parent (see §3.2's override case).

**Test.** Long-horizon runner: `scopedAuthOk` / `scopedDbOk` (already specced). Add `promoteOk`: assert `node = 20` in `apps/web` and `apps/control` → after sleep, root has it with inherit, and `packages/cli` gets it without a restate.

### 3.5 Context-dependent memory, place and grid cells, encoding specificity

**Bio.** Divers recalled word lists better in the environment where they learned them (Godden & Baddeley 1975). A meta-analysis finds reliable but moderate environmental-context effects, which are reduced when the learner mentally reinstates context (Smith & Vela 2001). **Encoding specificity**: a retrieval cue works to the degree that it was encoded with the item (Tulving & Thomson 1973). Place cells (O'Keefe & Dostrovsky 1971) and grid cells (Hafting et al. 2005; review Moser, Kropff & Moser 2008) give a location code, and **remapping** switches whole maps between environments (Colgin, Moser & Moser 2008). Contextual binding theory treats the hippocampus as binding items to their context (Yonelinas et al. 2019).

**Principle.** Retrieval probability should depend on overlap between the *encoding context vector* and the *retrieval context vector*, not only on content overlap. Contexts are hierarchical (repo ⊃ product folder ⊃ directory ⊃ file).

**Eden spec.**
- Context vector at encode: `ctx = {scope, dir, file?, branch?, ctx_epoch_session}`. Store `scope` (required), `dir` (dirname of the path, optional), and `branch` (if the hook has it; git HEAD read on sleep, not Submit).
- Retrieval context at Submit: the same fields from `open_files` / tool paths of the last turn (PostToolUse paths are the best place signal in a CLI agent. Most Claude prompts carry no files, but the last turn's Edit/Read tool paths do. Persist `last_paths[]` in `delivery.json`).
- Context match multiplier: `m_ctx = 1.0` exact dir, `0.8` same scope, `0.5` ancestor (pins only), `0` sibling (hard). This multiplies the activation in §3.9.
- **Remapping**: a scope switch *is* a remap. Dishabituation fires (§3.1). The packet header names the scope (`Eden Memory (apps/web):`), which reinstates the context for the model; that is reinstatement in the Smith & Vela sense.

**Serves.** G1 (the right thing arrives without the user naming the folder) and G2/G3 (sibling values excluded).

**Risks.** The context signal is often absent: bare prompts with no paths. Then the fallback is scope `""`, which is correct but thin. Branch as context is attractive (feature-branch facts), but branches are short-lived and would fragment facts. Keep it as a *boost*, not a key.

**Test.** Fixture: the same prompt "what db?" with `last_paths` in web vs cli returns postgres vs sqlite. With no paths, root only. Tool-path carryover: turn N edits `packages/cli/src/x.ts` and turn N+1 is a bare prompt, which yields cli scope.

### 3.6 Complementary learning systems, systems consolidation, sleep replay, schema-consistent fast consolidation

**Bio.** CLS: a fast, sparse hippocampal learner plus a slow, interleaved neocortical learner, which avoids catastrophic interference (McClelland, McNaughton & O'Reilly 1995). The updated version emphasizes replay and prioritization (Kumaran, Hassabis & McClelland 2016). Hippocampal place-cell sequences reactivate during sleep (Wilson & McNaughton 1994). Selectively disrupting sharp-wave ripples impairs spatial learning, which is causal evidence (Girardeau et al. 2009). Consolidation reviews: Frankland & Bontempi (2005); Squire et al. (2015); Diekelmann & Born (2010). **Schemas**: rats with a pre-learned flavour-place schema learned new pairs in one trial, and the new pairs became hippocampus-independent within **48 h** rather than weeks (Tse et al. 2007; gene-expression follow-up Tse et al. 2011). Schema-consistent information goes to neocortex quickly, while novel information depends on the medial temporal lobe (van Kesteren et al. 2012). Sleep **selects**: it benefits memories expected to be needed (Wilhelm et al. 2011), performs "memory triage" (Stickgold & Walker 2013), and globally downscales synapses (Tononi & Cirelli 2014). Overlapping replay builds schemas (Lewis & Durrant 2011).

**Principle.** (1) Keep a fast, lossless episodic write and a slow, compact semantic table. (2) Consolidation is **selection plus compression**, prioritized by tags. (3) Information consistent with an existing schema can bypass the slow path. (4) There is a global downscale so the index does not saturate.

**Eden spec.**
- **Encode (fast path, schema bypass)**: a clean copula `X is Y` whose subject is already a **known schema slot** (the live table has `(scope,s,*)` rows, or `s` is in the recognized slot list `auth|database|db|orm|framework|test runner|package manager|node|deploy|ci|lint|…`) writes **directly** into the live table at encode time. This is Tse: a pre-existing schema allows one-trial consolidation. Anything else, such as prose, a decision buried in a paragraph, or a tool outcome, stays episodic until sleep.
- **Sleep = triage**, run on Stop/SessionEnd/idle with the existing 25 ms incremental budget, plus a full pass:
  1. **Select** episodes for replay by `priority = tag_strength (§3.8) + 0.5·restate_count + 0.5·miss_count + 0.3·[kind∈{tool-fail→success, correction, decision}]`. Replay only the top N = 64 per pass **[tunable]**. Everything else stays in the diary untouched. This is the Wilhelm/Stickgold selection effect.
  2. **Compress**: selected episodes become copulas (heavier extractor is allowed here, possibly an LLM, because the lock only bans it on Submit), procedures (successful traces, dead ends stripped, already built), and gists.
  3. **Schema formation**: the cross-scope promotion from §3.4.
  4. **Downscale** (Tononi): multiply every index weight's `B_bonus` (§3.11) by 0.9 and recompute ACT-R activations (§3.9). Weights for rows not used since the last sleep fall; weights for used rows are protected by fresh `uses[]`. The diary never shrinks, only the index weights do.
  5. **Posting rebuild**: scoped postings, dropping stop-tokens and high-df verbs (the P5b spec).

**Serves.** G1 (facts buried in prose become retrievable keys), G2 (supersession happens inside the scope), and G4 (Submit reads compact rows, not diary text).

**Risks.** Sleep with an LLM extractor can hallucinate a fact. That is a G2 hazard, since a false fact is worse than a stale one. Mitigation: sleep-minted copulas carry `src=sleep` and a pointer to the episode ids. The packet label shows `[fact · sleep]`, and they never override a `src=user` copula of the same key. The Tse bypass is only as good as the slot list. A wrong slot parse ("Auth is failing") must not mint a fact; the existing M4 "failing-is does not delete Clerk" guard is exactly this.

**Test.** Buried decision: "…after the review we decided to move cli to sqlite because…" in a 400-word episode, followed by sleep, gives a `packages/cli|database = sqlite` live row pointing to the episode id. The slot bypass `node is 20` is live with no sleep. Triage: 1000 junk episodes + 5 tagged, after one pass, show that only the tagged ones produced rows. The junk count on disk is unchanged.

### 3.7 Reconsolidation: retrieval makes memory labile; prediction-error-triggered update

**Bio.** A reactivated fear memory required new protein synthesis in the amygdala to persist; blocking synthesis after recall erased it (Nader, Schafe & LeDoux 2000). The broader case is made in Nader & Hardt (2009). Crucially, destabilization needs a **prediction error** at reactivation. Without mismatch, recall does not open the trace (Sevenster, Beckers & Kindt 2013; review Lee, Nader & Schiller 2017). Retrieval that partially activates a competitor and is then contradicted can **differentiate or weaken** it (Kim, Norman & Turk-Browne 2017).

**Principle.** An update is cheapest and safest **at the moment of use**, when the old trace is active *and* the environment contradicts it. Without contradiction, retrieval should strengthen, not rewrite.

**Eden spec.**
- **Write-side (exists)**: LWW inside `(scope,s,p)` with serial-over-wall. Keep it.
- **Use-side reconsolidation window (new)**: when a copula is **delivered** at turn t, open a lability window `W = 3` turns **[tunable]**. `delivery.json.labile[cid] = t`. During W, PostToolUse / the next user turn are checked for contradiction of that specific key:
  - The user writes a conflicting copula for the same `(s,p)` gives **supersede**, stamped `corrected=1`, neuromodulator gain (§3.11), and a `harm` event on the old value (the HELP ledger).
  - Tool evidence contradicts it (e.g. the delivered fact says `test runner = jest`, the agent runs `vitest` and it succeeds, and `jest` fails with "command not found"). **Do not** auto-supersede from tools on the hot path. Emit a `pe_flag` for sleep, which can confirm with heavier logic. Sleep supersedes only with ≥ 2 independent contradictions **or** 1 contradiction plus 0 confirmations since.
  - The user or the agent proceeds consistently (no mismatch) gives **reinforce**: append to `uses[]` (the ACT-R practice effect). No rewrite. This follows Sevenster: no PE means no lability.
- **Stale detector** (sleep): for each live copula, if it was delivered ≥ 2 times and each time followed by a contradiction event that did not supersede (e.g. the user corrected in prose the extractor missed), mark `suspect=1` and exclude it from inject until re-confirmed. It is better silent than stale (G2 > G1 when they conflict, because a stale fact actively misleads).

**Serves.** G2 above all, plus G1: the correction is captured once and the user does not correct it again.

**Risks.** Tool-output contradiction detection is heuristic. False supersession is a severe error. Hence tools only **flag**, and sleep decides with a count. Biology here is a good guide: destabilization is gated, not automatic.

**Test.** Deliver jest; the next user turn says "we use vitest now". The next packet says vitest, and jest appears 0 times. Deliver jest, then an unrelated turn, gives no change and `uses` +1. Two tool contradictions followed by sleep gives `suspect` or supersede. A single tool contradiction gives no change.

### 3.8 Synaptic tagging and capture; behavioural tagging (importance marked after the fact)

**Bio.** Weak stimulation sets a local, transient **tag** at a synapse. If strong stimulation elsewhere within about 1–2 h triggers plasticity-related protein synthesis, the tagged synapse **captures** it and the weak potentiation becomes lasting (Frey & Morris 1997; review Redondo & Morris 2011). Behavioural analogue: exposure to novelty within a window around weak training converts short-term into long-term memory (Moncada & Viola 2007). In humans, fear conditioning **retroactively** strengthened memory for items from the same category seen *before* conditioning (Dunsmoor et al. 2015).

**Principle.** Importance often becomes known **after** encoding. Keep a cheap, decaying tag on every recent trace. When a strong event arrives, promote the tagged traces that are **related** and **temporally near**.

**Eden spec.**
- **Encode**: every episode and candidate fact gets `tag = 1.0` at write and `tag_t = turn`. Tag strength decays: `tag(now) = exp(-(turn - tag_t)/τ)`, with `τ = 8` turns **[tunable]**. This is about "within the session's recent working set".
- **Strong events** (each emits PRPs, i.e. plasticity-related "proteins"): a user **correction** ("no, …", "actually …", "that's wrong", a superseding copula); explicit **remember**/**always**/**never**; a **failure → success** transition in tools (test red then green); user **frustration** markers ("again", "I already told you", "why do you keep"); a commit/PR.
- **Capture** at the strong event: for each item i written in the last `2τ` turns, `capture_i = tag_i(now) · rel(i, event)`, where `rel` is token/FlyHash overlap with the event text plus an **identical scope** bonus (0.5). If `capture_i ≥ 0.3`, set `sal_i = max(sal_i, 0.6 + 0.4·capture_i)` and queue it for sleep replay priority (§3.6.1).
- "I already told you" is special. It is **both** a strong event and a G1 miss signal. Sleep must find what was told (search the diary for the current cue tokens in earlier turns) and mint it as a live row, not just tag it.

**Serves.** G1: the context around a correction (which file, which command) is consolidated. So is the "I already told you" loop.

**Risks.** Frustration markers are noisy and culture-dependent. Keep the list short and English-first, and log hits for audit. Over-capture: a big correction tags everything nearby. The relation term `rel` guards against this, and quotas in sleep (N=64) cap the damage.

**Test.** Turns 1–5 mention `src/auth/session.ts` in passing, and turn 6 says "no — the session cookie is httpOnly, remember that". After sleep, both the cookie rule (pinned) and a `[episode]` tied to `session.ts` score above untagged peers for cue "session cookie". Turn with "I already told you the port is 5433" gives a live row `port = 5433` after sleep **and** the `miss` log names the earlier turn.

### 3.9 Forgetting as a feature: rational analysis, ACT-R activation, active forgetting, retrieval-induced forgetting, interference

**Bio / cognitive.**
- **Rational analysis**: the probability that an item will be needed follows power functions of recency and frequency. Human forgetting and spacing curves mirror those environmental statistics, measured on *New York Times* headlines, child-directed speech, and e-mail (Anderson & Schooler 1991).
- **ACT-R base-level learning**: `B_i = ln( Σ_j t_j^(−d) )`, with `t_j` the time since the j-th use and `d ≈ 0.5`. Retrieval probability is `P = 1 / (1 + e^{−(A−τ)/s})` (Anderson et al. 2004). Pavlik & Anderson (2005) make decay depend on activation at the time of each practice, `d_j = c·e^{m_{j−1}} + α`, which reproduces the **spacing effect**: massed repetitions decay faster. The spacing effect itself is robust (Cepeda et al. 2006 meta-analysis). The historical curve is Ebbinghaus (1885; English translation reprinted 2013).
- **Active forgetting is regulated, not passive**. In *Drosophila*, Rac1 activity sets the rate of forgetting of olfactory memories: inhibiting it slows forgetting and activating it speeds it (Shuai et al. 2010). Ongoing dopamine signalling after learning actively erodes memory (Berry et al. 2012). Reviews: Hardt, Nader & Nadel (2013); Davis & Zhong (2017). Richards & Frankland (2017) argue transience **optimizes decisions** by removing outdated detail and aiding generalization.
- **Interference**: most everyday forgetting is interference from other learned material, not time (Underwood 1957; Wixted 2004).
- **Retrieval-induced forgetting (RIF)**: practising retrieval of some items suppresses related competitors (Anderson, Bjork & Bjork 1994). Neurally, the competitors' cortical patterns are suppressed (Wimber et al. 2015). There is a network model in which moderate competitor activation weakens it (Norman, Newman & Detre 2007). A recent review frames this as prefrontal control (Anderson & Hulbert 2021).

**Principle.** Truth and need are different quantities. **Validity** is binary and handled by supersession (§3.7). **Accessibility** should equal estimated need-probability from use history (recency, frequency, spacing) times context match. Forgetting should remove things from the *default retrieval path*, not from disk. When one value wins, its competitors should be actively suppressed, especially **episodes that still mention the old value**.

**Eden spec.**
- Row fields: `uses: number[]` (last 8 use timestamps, in hours since epoch; a "use" = delivered-and-not-contradicted, or user/agent mention), `n_uses`, `t_first`. Persist `at` (the P1 bug fix makes this possible).
- **Activation** at Submit (cheap, closed form):
  ```
  B = ln( Σ_{j∈last8} max(t_j, 0.25h)^(−d) + (n−8)·approxTail )    // Petrov (2006) Eq. 3 tail approx
  d = 0.5 default; for rows whose uses are massed (median gap < 10 min) use d = 0.7
  A = B + B_bonus(sal, pin) + ln(m_ctx) + W·S_cue
  ```
  `S_cue` is the existing overlap/rare score, normalized to [0,1], with weight `W = 2`. `B_bonus = 3·sal`. Pins get `+∞` on eligibility but still participate in habituation. **Kind boosts (50/40/25/0) are replaced** by `B_bonus` + `A` ranking plus the quotas from §3.3. Retrieval threshold: include a bullet only if `A ≥ τ`. Start with τ = the 20th percentile of A among items that were **helpful** in the HELP ledger **[tunable]**.
- **Validity versus accessibility**: live copulas never *expire* from the store (EDEN-MEMORY lock). Low activation only means they need a stronger cue (exact subject in the cue). Humans behave the same way: old but true facts need a specific cue.
- **Active forgetting job** (sleep; Rac1 analogue): rows with `A_now < τ_forget` and no pin, sal < 0.6, not used in 90 days are **removed from default postings** and moved to `cold-postings` (rare-id tokens only: hashes, ids, error codes, test names). The diary is untouched. A buried `op00042` still packs because rare-id tokens stay posted: the "silent engram" idea, where a trace inaccessible to ordinary cues is still reachable by an exact one (Ryan et al. 2015). The job has a **rate** knob `EDEN_FORGET_RATE` (like Rac1 activity), and it is 0 while the user is active in that scope this week.
- **RIF at supersession** (encode + sleep): when `(scope,s,p)` changes from `o_old` to `o_new`, every **episode** in that scope containing tokens of `s` **and** `o_old` gets `stale_for: [cid]`. At Submit, an episode with `stale_for ∋ cid` is excluded whenever the cue names subject `s`. This closes the most common G2 leak: the stale fact is tombstoned but a diary bullet like `[episode] set up postgres for cli` still carries it into the packet.
- **Interference budget**: if a scope has > 30 live rows sharing a subject token, sleep flags it as an interference hotspot. Retrieval there requires a predicate match, not just the subject.

**Serves.** G2 (RIF on stale episodes), G3 (low-need items stay out), G1 (frequently used facts win ties), G4.

**Risks.** Use-history is only as good as the "use" signal. If injection counts as use, the system is self-reinforcing: popular items stay popular, like a rich-get-richer ant trail. Mitigation: a delivery counts as a use **only** if the next turn does not contradict it **and** at least one of its content tokens appears in the agent's subsequent actions or answer (checked in sleep). Otherwise it is a *non-use* and slightly lowers `sal`. The `d` values come from human verbal learning; agent workloads have different statistics. Anderson & Schooler's real claim is to **fit the environment**, so fit `d` on Eden's own logs in sleep. The fitting is trivial: logistic regression of "was needed at t" on `ln Σ t^-d` over a d grid.

**Test.** Offline, from the HELP/hook logs: AUC of `A` versus the current kind-boost score for predicting "bullet was helpful". RIF fixture: cli postgres→sqlite, then cue "cli db setup". No bullet containing `postgres` appears; the diary still contains it. Active forgetting: after sleep with rate > 0, the 5-year junk arm shows a smaller postings file, `op00042` still packs, and the scoped flags stay true.

### 3.10 Sparse coding and fly olfaction: FlyHash and FlyBloom on the hot path

**Bio.** In the fly olfactory circuit, about 50 projection-neuron types project **sparsely and randomly** onto about 2,000 Kenyon cells, each sampling roughly 6 inputs, which is an expansion of about 40×. APL feedback inhibition leaves about 5% of Kenyon cells active, a winner-take-all tag. Dasgupta, Stevens & Navlakha (2017) showed this is a **locality-sensitive hash**, and that it beat dense random-projection LSH on nearest-neighbour benchmarks. Sparse, decorrelated Kenyon-cell coding improves discrimination (Lin et al. 2014). The same group turned the mushroom-body output compartment MBON-α′3, which responds to novel odours and habituates to familiar ones (Hattori et al. 2017), into a distance- and time-sensitive **Bloom filter** for novelty (Dasgupta et al. 2018; classical Bloom 1970). General sparse-coding background: Olshausen & Field (1996). SimHash is a related classical LSH (Charikar 2002).

**Principle.** A sparse random expansion followed by top-k gives similarity-preserving binary codes. Computing them costs a few thousand integer adds, with no training and no floating-point matrices. Set-overlap on the codes approximates similarity *in the input feature space*. A decaying Bloom filter over those codes answers "have I seen something like this recently?" in O(k).

**Eden spec.**
- **Features** (deterministic, no vectors): character 3-grams of each content token, plus whole tokens, plus path segments, hashed into `D = 1024` buckets (feature hashing) with counts. The 3-grams give morphology robustness: `auth`, `authn`, `authentication`, `oauth` share `aut` and `uth`. So do `postgres`, `postgresql` and `pg_*`.
- **Projection**: a fixed seeded sparse binary matrix, `M = 4096` "Kenyon" units, each summing **6** random input buckets. **WTA** keeps the top `k = 32` (0.8%) as the hash: a set of 32 uint16. Cost: 4096×6 ≈ 25k adds per cue. That is microseconds.
- **Where computed.** Row hashes are computed at **encode**, or in sleep for backfill, and stored as `fh: uint16[32]`. The cue hash is computed at **Submit**. Similarity is `|fh_row ∩ fh_cue| / 32`.
- **Use 1 — candidate recall for misses**: when the lexical pool from scoped postings is empty or has fewer than 3 hits, score the *scoped live table* (hundreds to thousands of rows) by FlyHash overlap and admit the rows with `sim ≥ 0.25`. This gives morphological and near-spelling recall **without** cue-time synonym explosion, which is banned by the lock. At 10⁶ rows it runs only on the scoped subset (≤ 10⁴ × 32 compares ≈ well under 1 ms).
- **Use 2 — lateral inhibition similarity** for §3.3: more robust than bullet Jaccard.
- **Use 3 — FlyBloom novelty at encode**: a decaying counting Bloom over FlyHash codes of the last 2,000 episodes per scope. If the new episode's familiarity is above 0.9 (a near-duplicate of recent text, e.g. the same log line pasted 20 times), store it in the diary, but **do not post it**. Increment `reps` on the nearest existing row. This keeps postings from fattening, which was the long-horizon failure cause.
- **What it cannot do**: real synonyms with no shared features (`db` ↔ `database`, `k8s` ↔ `kubernetes`, `auth` ↔ `login`). Those come from **sleep-written aliases on the row** (P6), learned from miss logs (§3.2) and co-occurrence. Semantics are learned slowly, offline, and stored as data. The hot path stays lexical plus hashing. That respects the lock "no embeddings on Submit".

**Serves.** G1 (morphological misses), G4, and G5/G3 (near-duplicate suppression).

**Risks.** Dasgupta's gains were shown on *dense* inputs (SIFT, GloVe, MNIST). The benefit on sparse, hashed text features is **untested**. Plain 3-gram Jaccard may do as well. FlyHash must beat the plain baseline on Eden's miss log, or it is not shipped. Trigram overlap can create false matches (`test` ↔ `latest`). The `sim ≥ 0.25` threshold plus scope filter plus required subject match for copulas limits the damage.

**Test.** Build a miss set from `miss.jsonl` plus synthetic morphology pairs (`authentication`/`auth`, `postgresql`/`postgres`, `vitest.config.ts`/`vitest`). Measure recall@6 for lexical only, lexical + trigram Jaccard, and lexical + FlyHash, each at equal false-inject rate on the silence set (`2+2`, `thanks`, junk). Ship FlyHash only if it beats trigram Jaccard by at least 3 points at equal false rate. Otherwise ship Jaccard and cite the negative result.

### 3.11 Neuromodulation: dopamine, noradrenaline, acetylcholine as write gain and mode

**Bio.** Amygdala noradrenergic activity enhances consolidation of emotionally arousing events (McGaugh 2004). Arousal amplifies high-priority representations and suppresses low-priority ones: "arousal-biased competition" (Mather & Sutherland 2011). Dopamine carries reward prediction error (Schultz et al. 1997) and gates hippocampal LTP for novel events (Lisman & Grace 2005). LC-NE implements adaptive gain, switching between exploitation and exploration (Aston-Jones & Cohen 2005). Acetylcholine is high during active waking, favouring encoding, and low during slow-wave sleep, favouring consolidation and retrieval to cortex (Hasselmo 2006). Yu & Dayan (2005) propose that ACh signals expected uncertainty and NE unexpected uncertainty.

**Principle.** A small number of global scalar signals set (a) **how strongly** the current moment is written, (b) **what gets priority** in later replay, and (c) whether retrieval should **exploit** (narrow, top-1 fact) or **explore** (broaden to procedures and episodes).

**Eden spec.**
- **Signals** (regex on the user turn plus tool exit codes, computed at encode):
  | Signal | Detector | Gain `g` |
  |---|---|---|
  | Explicit remember/always/never | existing pin regex | pin (∞) |
  | Correction | "no,", "actually", "that's wrong", superseding copula | 0.9 |
  | Frustration / restate | "again", "I already (told|said)", "why do you keep", "as I said" | 0.9 + miss-log |
  | Failure→success | exit≠0 then exit=0 on the same command within 5 tool calls | 0.7 (procedure lane) |
  | Decision | "we decided", "let's go with", "from now on" | 0.7 |
  | Surprise (novel slot) | §3.2 `pe=1` | 0.5 |
  | Routine | none | 0.2 |
- `sal = max(sal, g)`. It drives **encode** (whether to post a fact directly), **sleep** (replay priority, §3.6), and **Submit** (`B_bonus` in §3.9).
- **Exploit/explore (NE)**: keep a per-session `fail_streak` of consecutive non-zero tool exits or user corrections. When `fail_streak ≥ 3`, Submit switches to **explore mode**: allow the procedure lane without a how-to cue, allow 1 extra episode of a past resolution in this scope, and lower τ slightly. When it is 0, **exploit mode**: facts only, strict τ. This is the one place where the packet should *grow* toward the cap, because the agent is stuck.
- **Mode (ACh)**: the hot path is encode mode (write fast, no consolidation), and sleep is consolidation mode. Eden already has this split. The lesson is to **never consolidate on Submit**, which the lock already implies.

**Serves.** G1 (corrections and restates stick), G4 (packet stays lean when things go well), and helps when the agent is stuck.

**Risks.** Regex affect detection is brittle and English-only. Sarcasm and pasted quotes ("the error says 'wrong'") create false gains. Mitigation: detectors only look at user-authored text outside code fences, and gains only *raise* salience. Salience alone never injects: relevance is still required.

**Test.** Holdout sessions with injected corrections: the corrected fact has higher replay priority and is live after sleep. `fail_streak` fixture: three failing `npm test` runs, and the next packet contains the scope's how-to. After a green run, the packet returns to facts-only.

### 3.12 Working-memory capacity and chunking

**Bio.** The capacity limit is about 4 ± 1 chunks when rehearsal and chunking are controlled (Cowan 2001). Miller's 7 ± 2 (1956) overstated it by counting chunked items. Chunking is how experts carry more (Gobet et al. 2001).

**Principle.** The unit of load is the *chunk*, not the byte. Packets should be about ≤ 4 independent ideas, each a coherent chunk.

**Eden spec.** Keep the lock (≤ 6 bullets, 900 B) as a **hard ceiling**. Add a **soft target of 4 chunks** in exploit mode. **Chunking at pack time**: facts with the same subject and scope merge into one bullet (`auth: provider=Clerk · callback=/api/clerk`), which counts as one chunk and saves header bytes. Procedures are already chunks (one bullet).

**Why this matters for LLMs (and where the analogy breaks).** An LLM has no 4-item store. The real reasons to keep the packet small are measured in LLMs themselves: degraded use of mid-context and distractor content (Liu et al. 2024), and token cost. Cowan motivates the unit, and the evidence for the size comes from LLM studies. Do not cite Cowan as proof that 4 is optimal for Claude.

**Test.** A/B on the coding holdout: soft-4 versus hard-6. Measure helped/harmed and bytes. Keep whichever has more helped per byte with harmed ≤ baseline.

### 3.13 Priming, tip-of-the-tongue, feeling-of-knowing → pointer injection and a cheap "should I even look?" gate

**Bio.** Priming is implicit facilitation by prior exposure without conscious recollection, and it is a distinct memory system (Tulving & Schacter 1990). Feeling-of-knowing: people predict above chance whether they will recognize an answer they cannot currently recall (Hart 1965). In tip-of-the-tongue states, people know partial attributes (first letter, syllable count) of a word they cannot retrieve (Brown & McNeill 1966). Koriat's accessibility model says feeling-of-knowing is computed from the amount and ease of partial information that comes to mind, *not* from privileged access to the target (Koriat 1993).

**Principle.** Metamemory is a cheap familiarity signal computed *before* or *instead of* full retrieval. It can (a) decide whether to retrieve at all, and (b) let the system say "I know something about X" and where it lives, without paying for the content.

**Eden spec.**
- **FOK gate (Submit, first step)**: `fok = FlyBloom familiarity(cue)` in the current scope (§3.10), plus a count of scoped posting hits for the rarest two cue tokens. If `fok < 0.1` and there are no pin triggers, return silence immediately. This is a faster and more principled replacement for part of `isNoopCue`: it is scope-aware, so "deploy" in a scope that has never discussed deploys is silent.
- **Pointer bullet** (Koriat-style partial retrieval): when ≥ 3 candidates pass τ for one subject but the budget allows only 1, or the best item is long (an ADR, a 20-line procedure), inject **one pointer** instead of the content. The pointer must name something the agent can open with its *normal* tools, because `memory_search` is a non-goal:
  `- [see] docs/adr/0007-auth.md — auth decision 2026-08 (3 notes)`
  `- [see] eden memory show auth@apps/web — 3 facts` (only if the operator enabled the CLI read; default off)
  Episodes that came from a repo file carry that path. Pointer bullets cost about 60 B and let the model decide.
- **Priming (implicit)**: the scope header `Eden Memory (apps/web):` is itself a prime. It reinstates context at a cost of about 20 B. No other "implicit" injection. Hidden steering text is not priming, it is prompt injection.

**Serves.** G4 and G3 (fewer bytes, less noise), and G1 (the agent learns *that* a decision exists and where to find it).

**Risks.** A pointer is useless if the agent ignores it. That is the same risk as any bullet, and it can be measured. Pointers to files that later move go stale; check existence at sleep.

**Test.** Fixture with a long ADR: the packet has 1 pointer and no content. The agent's next tool call is `Read docs/adr/0007-auth.md` in ≥ N% of holdout runs. FOK gate: the silence-set false-inject rate does not rise, and p50 Submit on silent cues drops.

### 3.14 Immune memory, stigmergy, slime mould: only what adds something new

Most of these reduce to "reinforce with use, decay without it", which §3.9 already covers with a better-grounded formula. Each is kept only for one idea it adds.

- **Immune memory — contraction and affinity maturation.** After an immune response, about 90–95% of effector T cells die, and a small long-lived memory pool remains (Kaech, Wherry & Ahmed 2002). In germinal centres, B cells mutate their receptors and are **selected for higher affinity** (Victora & Nussenzweig 2012).
  **Adds (1): contraction after a burst.** A feature push produces hundreds of episodes in one scope over days. When the scope goes idle for 14 days, or the branch merges, sleep **contracts** it: keep the copulas, procedures and at most 3 gist bullets. Lower the burst episodes' `B_bonus` to 0 and move them to cold postings (§3.9). Keep them in the diary.
  **Adds (2): affinity maturation of cue aliases.** In sleep, for each miss (§3.2), propose candidate aliases from the miss cue ("mutations"), replay the last 200 cues, and **keep an alias only if** it increases hits for its row without creating a new false inject on the silence set ("selection"). This is the only acceptable way to widen `WRITE_ALIASES` automatically.
- **Stigmergy / ant pheromone evaporation** (Theraulaz & Bonabeau 1999; Dorigo, Maniezzo & Colorni 1996): trails reinforced by use and evaporating exponentially. **Adds:** only for **subagents**. Children may deposit a "trail" of `uses` on parent-scope rows they found helpful, without writing facts. The parent's activation absorbs this at sleep. That respects "children cannot prune the parent" (M45) while still letting them vote. Evaporation is ACT-R decay. Nothing else new.
- **Slime mould (Physarum)**: tubes carrying more flux thicken and unused tubes shrink, which approximates efficient networks (Tero et al. 2010). **Adds:** reinforce **cue→item edges**, not items. Store small counts `edge[(cueToken, cid)]` for cue tokens that led to *helpful* deliveries. At Submit, use them as a learned lexical association bonus (bounded by +1 in `S_cue`). This is Hebbian, cheap, and lookup-only, and it complements affinity maturation.

**Risk** common to all three: self-reinforcing loops. The helpful-only rule (§3.9) is mandatory.

### 3.15 Prospective memory: cue-triggered intentions

**Bio.** Prospective memory means remembering to perform an intended action later (Einstein & McDaniel 2005). The multiprocess view: with **focal** cues, retrieval is largely spontaneous and cue-driven; with non-focal cues, it needs costly monitoring (McDaniel & Einstein 2000).

**Principle.** Store intentions as `(trigger → action)` with triggers that the environment will *present*, so that no monitoring cost is paid on every turn.

**Eden spec.**
- **Encode**: an extractor for `when|before|after|next time|once|if … (then)? …`, "remind me to", "don't forget to", "TODO after …". Output:
  ```
  { id, kind:"intent", scope, action:"bump version in package.json",
    trigger:{ tokens?:["release","publish"], path?:"packages/cli/**", event?:"git commit"|"Stop"|"tests green",
              after?:ISOtime }, mode:"once"|"every", expires: t+30d, done:false }
  ```
- **Submit**: evaluate triggers against the cue tokens, scope and `last_paths`. This is a set lookup; intents are few, so it is O(#intents). A hit injects `- [todo] bump version in package.json (you asked 2026-09-20, on release)`. Intents **bypass the habituation refractory period** until done, but have their own 5-turn refractory period so they do not nag.
- **Other hooks**: if the host fires PostToolUse/Stop, evaluate `event` triggers there too (e.g. a `git commit` tool call → a PreCommit-type intent is surfaced on the *next* Submit, the only channel Eden has, since it does not block).
- **Done detection**: the user says done, tool evidence matches the action text, `mode=once` has been delivered and the user acknowledged it, or expiry. Done intents leave the index.
- The M43 lock stays: "don't forget to…" is an intent, not a tombstone.

**Serves.** G1: the user never has to repeat "remember to do X when Y".

**Risks.** Extraction false positives ("when I ran it, it failed" is not an intent). Require the action clause to be an imperative with a future or conditional marker. Intents with no trigger overlap are never surfaced and silently rot, so sleep lists intents older than 7 days with 0 deliveries in `miss.jsonl` for audit.

**Test.** "Before you publish the cli, bump the version" then 30 junk turns, then a cue "publish cli" in `packages/cli`: the packet contains the `[todo]`. The same cue in `apps/web` does not. After a `version` bump tool event, it is gone.

---

## 4. The Eden nature stack (integrated)

```
                ┌────────────────────────── ENCODE (observe / remember; after inject) ───────────────────────────┐
 user turn  ──► │ neuromodulator gain g (3.11) → sal                                                              │
 tool events    │ prediction error vs live table (3.2): novel ⇒ insert · same ⇒ reps++, restate log · diff ⇒ supersede│
                │ schema slot? ⇒ direct live write (Tse bypass, 3.6)        else ⇒ episode only                  │
                │ scope stamp = DG separation key (3.4/3.5)                  FlyHash fh[32] (3.10)                │
                │ FlyBloom familiarity > .9 ⇒ diary only, no postings (3.10)                                     │
                │ tag=1, decays τ=8 turns; strong event ⇒ capture nearby tags (3.8)                              │
                │ supersede ⇒ RIF: stale_for on episodes carrying old value (3.9)                                │
                │ intent extractor ⇒ trigger→action rows (3.15)                                                  │
                └────────────────────────────────────────────────────────────────────────────────────────────────┘
                ┌────────────────────────────── SUBMIT (fresh process, lexical, ~ms) ────────────────────────────┐
 prompt +       │ 0 context: scope from open_files | last_paths ; ctx_epoch (3.1/3.5)                            │
 open files ──► │ 1 FOK gate: familiarity + rare-token hits; low ⇒ silence (3.13)                                │
                │ 2 candidates: keyed live (scope,s,*) + inherited pins + scoped postings (≤64) +                 │
                │   intent triggers (3.15) ; FlyHash backfill if pool < 3 (3.10)                                 │
                │ 3 filter: sibling scope = 0; superseded = 0; stale_for = 0; suspect = 0 (3.4/3.7/3.9)          │
                │ 4 rank: A = B(uses,d) + 3·sal + ln m_ctx + 2·S_cue ; keep A ≥ τ (3.9)                          │
                │ 5 habituate: drop cid delivered this epoch w/ same ver; pins R=20; dishabituate on             │
                │   version change / violation / epoch bump (3.1)                                                │
                │ 6 residual: drop bullets whose content is already in the prompt (non-questions) (3.2)          │
                │ 7 lateral inhibition + WTA per (s,p) + kind quotas; chunk same-subject facts (3.3/3.12)        │
                │ 8 pointer instead of content when budget-bound or long (3.13); explore mode if fail_streak≥3   │
                │ 9 pack ≤6/900 (soft 4) · header names scope · write delivery.json · open lability window (3.7) │
                └────────────────────────────────────────────────────────────────────────────────────────────────┘
                ┌───────────────────────────────── SLEEP (Stop / SessionEnd / idle; heavy allowed) ─────────────┐
 diary +        │ triage: replay top-N by tag+restate+miss+kind priority (3.6/3.8)                               │
 delivery log   │ compress → copulas (src=sleep, provenance), procedures, gists                                  │
 + tool log ──► │ reconsolidate: pe_flags ≥2 ⇒ supersede/suspect (3.7)                                           │
                │ restate ⋈ delivered ⇒ miss.jsonl ⇒ alias affinity maturation w/ silence-set selection (3.2/3.14)│
                │ helpful-use accounting ⇒ uses[] / sal down on non-use; cue→item edges (3.9/3.14)               │
                │ schema promotion: same (s,p,o) in ≥2 siblings ⇒ ancestor inherit (3.4)                         │
                │ downscale B_bonus×0.9; fit d on own logs; active forgetting to cold postings (3.6/3.9)         │
                │ contraction of idle bursts (3.14); intent audit (3.15); pointer file existence check (3.13)    │
                └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why the combination minimizes both error types

There are two opposing failure families. Any single knob trades one for the other. The stack separates them so that each has its own control.

| Failure | Caused by | Stack components that push it down | Why they do not raise the opposite error |
|---|---|---|---|
| **Miss / restate (G1)** | wrong scope, global haystack, missing alias, fact buried in prose, forgotten intent, over-silence | scope key (DG), keyed live table, schema bypass, sleep triage of buried decisions, restate→miss→alias maturation, FlyHash backfill, tagging after corrections, cue-triggered intents, pointer bullets | Each **adds candidates** only under a scope filter plus an activation threshold, and aliases are *selected* against a silence set. |
| **Stale (G2)** | old value in a sibling or ancestor scope, stale episodes, unconfirmed tool drift | exact-scope copulas, LWW, reconsolidation window, **RIF `stale_for` on episodes**, suspect flag, sleep provenance | These only **remove** candidates, and they are keyed to a specific `(scope,s,p)`, so they cannot remove unrelated gold. |
| **Irrelevant (G3)** | lexical coincidence, generic tokens, junk volume | FOK gate, τ on activation, FlyBloom de-dup of postings, lateral inhibition, active forgetting of never-used rows | Rows removed from default postings stay reachable by rare-id tokens (silent engram), so buried needles still pack. |
| **Redundant (G5)** | the fresh process forgets what it just said; the user's own sentence echoed back | habituation ledger with epochs, residual (prediction) filter, WTA per key, chunking | Dishabituation on **version change, violation, epoch bump, scope change** re-opens exactly the cases where repetition *is* useful. |

The core claim is this. Today Eden uses **one** mechanism, lexical overlap plus silence, to fight **four** error types. Biology uses **separate** circuits: separation for interference, supersession for staleness, habituation for redundancy, familiarity for irrelevance, and tagging/replay for misses. Separating the controls is what makes it possible to push all four down at once.

---

## 5. What is hype in "bio-inspired" AI memory

1. **"Ebbinghaus forgetting curve" decay of stored facts** (MemoryBank and its successors; Zhong et al. 2024). Ebbinghaus measured nonsense syllables. Applying a timer-driven exponential to *facts* confuses **need** with **truth**: a two-year-old `db = postgres` is still true. Anderson & Schooler (1991) is the principled version. Decay **accessibility** by fitted power-law need, never validity. Supersession, not time, retires facts.
2. **"Hippocampal" retrieval that is a knowledge graph plus Personalized PageRank** (HippoRAG; Gutiérrez et al. 2024, arXiv:2405.14831). It is a useful engineering idea, loosely inspired by indexing theory (Teyler & DiScenna 1986), but the label predicts nothing. On MemoryAgentBench, per Eden's own ledger, HippoRAG-v2 41.6 ≈ BM25 41.5. Judge it as graph retrieval.
3. **"Sleep / reflection" = an LLM summarizing its logs** (Generative Agents reflection, Park et al. 2023; many "memory consolidation" products). Biological consolidation is **selective, interleaved and provenance-preserving** (Stickgold & Walker 2013; Kumaran et al. 2016). LLM summaries drop provenance and can hallucinate, and nothing *selects*. Eden's sleep must triage and keep episode pointers.
4. **LLM-rated "importance" (1–10) per memory** (Park et al. 2023). It is an uncalibrated model call per write. Biology's salience signals are **events**: prediction error, correction, reward, failure→success (§3.11). Detect the events and skip the rating.
5. **"Human-like working memory of 7±2"** to justify a context size. Miller is superseded by Cowan (≈ 4 chunks), and neither applies to transformers. Keep packets small for LLM-measured reasons (Liu et al. 2024) and cost.
6. **"Episodic memory"** for any stored chat log. Episodic means bound to time and context and retrievable by context (Tulving). A log without scope, time and context-dependent retrieval is a transcript. Credit where due: surprise-based **event segmentation** (EM-LLM; Fountas et al. 2025, arXiv:2407.09450) is grounded in event-segmentation research (Zacks et al. 2007), and the **"surprise"** gating in test-time memorization (Titans; Behrouz et al., arXiv:2501.00663) is a genuine prediction-error mechanism. It is weight-level and irrelevant to a hook, but not hype.
7. **"Emotional memory" via sentiment scores.** Arousal biases *competition* (Mather & Sutherland 2011). It is not positive/negative valence. For a coding agent the arousal events are corrections and failures, not sentiment.
8. **"Infinite / never-forgetting memory" as a feature.** Biology treats forgetting as adaptive (Richards & Frankland 2017; Davis & Zhong 2017). Never deleting the diary is fine. Never *de-indexing* is the long-horizon failure Eden measured: more rows, worse retrieval.
9. **FlyHash as "semantic search without embeddings."** It is LSH over whatever features it is given. It does not create synonymy. It is honest only as a *fast similarity over lexical features*. Semantics come from sleep-learned aliases.
10. **Brain-region names as architecture.** "PFC module", "amygdala module" and so on add nothing unless each maps to a field, a formula and a test. This appendix drops any analogy that does not. MEMORY-PLAN's CA3 "pattern completion" claim for token overlap is an in-house example.

---

## 6. Build order (fits EDEN-MEMORY P-slices; does not change locks)

| Order | Mechanism | Slice | Why first |
|---|---|---|---|
| 1 | Scope as DG key; exact copulas; pins inherit | P1 (already planned) | Nothing else is meaningful while `(s,p)` collides globally |
| 2 | **Habituation ledger** `delivery.json` + epochs + dishabituation | new, **P4.10** | G5 is unmeasured and unaddressed; about 150 LOC; fail-open |
| 3 | RIF `stale_for` on episodes at supersede | P2/P3 | Closes the stale-episode G2 leak that live copulas alone do not fix |
| 4 | Restate detector → `miss.jsonl` → alias maturation | P6 | Turns every user restatement into training data for G1 |
| 5 | ACT-R activation replaces kind boosts; persist `uses[]`/`at` | P3/P4 | Principled rank; needs the P1 `at` fix |
| 6 | Neuromodulator gains + tag-and-capture | P4/P6 | Corrections and "I already told you" stick |
| 7 | Prospective intents | new | Removes a whole class of restatement |
| 8 | Lateral inhibition / WTA / chunking | M39 hardening | Mostly exists; formalize and test |
| 9 | FlyHash/FlyBloom | P7 alternative | Only if it beats trigram Jaccard on the miss log (§3.10 test) |
| 10 | Sleep triage, schema promotion, contraction, active forgetting | P5/P5b | Needed at 10⁴–10⁶ rows |

**New metrics for `benchmarks/memory-long-horizon/run.ts` and the live holdout:** `restate_rate`, `stale_rate` (must be 0), `false_rate`, `redundant_rate`, `bytes_per_helpful_bullet`. A mechanism ships only if it lowers its target metric **without raising any other one** beyond noise across 3 seeds.

---
## R. References

✓ means the DOI was resolved on Crossref on 2026-09-29 and matched the author, year, venue and pages. † means it was **not** machine-verified in this session and must be checked before external citation. **Audit 2026-09-29:** every former † item below was re-checked (Crossref, arXiv API, publisher or author pages); none remain.

**Habituation, repetition suppression, novelty, prediction**
- Thompson, R. F., & Spencer, W. A. (1966). Habituation: A model phenomenon for the study of neuronal substrates of behavior. *Psychological Review*, 73, 16–43. https://doi.org/10.1037/h0022681 ✓
- Rankin, C. H., et al. (2009). Habituation revisited: An updated and revised description of the behavioral characteristics of habituation. *Neurobiology of Learning and Memory*, 92, 135–138. https://doi.org/10.1016/j.nlm.2008.09.012 ✓
- Desimone, R. (1996). Neural mechanisms for visual memory and their role in attention. *PNAS*, 93, 13494–13499. https://doi.org/10.1073/pnas.93.24.13494 ✓
- Grill-Spector, K., Henson, R., & Martin, A. (2006). Repetition and the brain: neural models of stimulus-specific effects. *Trends in Cognitive Sciences*, 10, 14–23. https://doi.org/10.1016/j.tics.2005.11.006 ✓
- Summerfield, C., et al. (2008). Neural repetition suppression reflects fulfilled perceptual expectations. *Nature Neuroscience*, 11, 1004–1006. https://doi.org/10.1038/nn.2163 ✓
- Ulanovsky, N., Las, L., & Nelken, I. (2003). Processing of low-probability sounds by cortical neurons. *Nature Neuroscience*, 6, 391–398. https://doi.org/10.1038/nn1032 ✓
- Rao, R. P. N., & Ballard, D. H. (1999). Predictive coding in the visual cortex. *Nature Neuroscience*, 2, 79–87. https://doi.org/10.1038/4580 ✓
- Friston, K. (2005). A theory of cortical responses. *Phil. Trans. R. Soc. B*, 360, 815–836. https://doi.org/10.1098/rstb.2005.1622 ✓
- Schultz, W., Dayan, P., & Montague, P. R. (1997). A neural substrate of prediction and reward. *Science*, 275, 1593–1599. https://doi.org/10.1126/science.275.5306.1593 ✓
- Lisman, J. E., & Grace, A. A. (2005). The hippocampal-VTA loop: controlling the entry of information into long-term memory. *Neuron*, 46, 703–713. https://doi.org/10.1016/j.neuron.2005.05.002 ✓
- Ranganath, C., & Rainer, G. (2003). Neural mechanisms for detecting and remembering novel events. *Nature Reviews Neuroscience*, 4, 193–202. https://doi.org/10.1038/nrn1052 ✓
- Greve, A., Cooper, E., Kaula, A., Anderson, M. C., & Henson, R. (2017). Does prediction error drive one-shot declarative learning? *Journal of Memory and Language*, 94, 149–165. https://doi.org/10.1016/j.jml.2016.11.001 ✓

**Attention, inhibition, competition**
- Posner, M. I., & Cohen, Y. (1984). Components of visual orienting. In H. Bouma & D. G. Bouwhuis (Eds.), *Attention and Performance X* (pp. 531–556). Erlbaum. ✓ (no DOI; pages confirmed against multiple bibliographic records and a hosted copy of the chapter, 2026-09-29)
- Posner, M. I., Rafal, R. D., Choate, L. S., & Vaughan, J. (1985). Inhibition of return: Neural basis and function. *Cognitive Neuropsychology*, 2, 211–228. https://doi.org/10.1080/02643298508252866 ✓
- Klein, R. M. (2000). Inhibition of return. *Trends in Cognitive Sciences*, 4, 138–147. https://doi.org/10.1016/S1364-6613(00)01452-2 ✓
- Hartline, H. K., Wagner, H. G., & Ratliff, F. (1956). Inhibition in the eye of *Limulus*. *Journal of General Physiology*, 39, 651–673. https://doi.org/10.1085/jgp.39.5.651 ✓
- Maass, W. (2000). On the computational power of winner-take-all. *Neural Computation*, 12, 2519–2535. https://doi.org/10.1162/089976600300014827 ✓
- Carbonell, J., & Goldstein, J. (1998). The use of MMR, diversity-based reranking for reordering documents and producing summaries. *SIGIR '98*, 335–336. https://doi.org/10.1145/290941.291025 ✓

**Hippocampus: separation, completion, context, place**
- Treves, A., & Rolls, E. T. (1994). Computational analysis of the role of the hippocampus in memory. *Hippocampus*, 4, 374–391. https://doi.org/10.1002/hipo.450040319 ✓
- Leutgeb, J. K., Leutgeb, S., Moser, M.-B., & Moser, E. I. (2007). Pattern separation in the dentate gyrus and CA3 of the hippocampus. *Science*, 315, 961–966. https://doi.org/10.1126/science.1135801 ✓
- Yassa, M. A., & Stark, C. E. L. (2011). Pattern separation in the hippocampus. *Trends in Neurosciences*, 34, 515–525. https://doi.org/10.1016/j.tins.2011.06.006 ✓
- Teyler, T. J., & DiScenna, P. (1986). The hippocampal memory indexing theory. *Behavioral Neuroscience*, 100, 147–154. https://doi.org/10.1037/0735-7044.100.2.147 ✓
- O'Keefe, J., & Dostrovsky, J. (1971). The hippocampus as a spatial map. *Brain Research*, 34, 171–175. https://doi.org/10.1016/0006-8993(71)90358-1 ✓
- Hafting, T., Fyhn, M., Molden, S., Moser, M.-B., & Moser, E. I. (2005). Microstructure of a spatial map in the entorhinal cortex. *Nature*, 436, 801–806. https://doi.org/10.1038/nature03721 ✓
- Moser, E. I., Kropff, E., & Moser, M.-B. (2008). Place cells, grid cells, and the brain's spatial representation system. *Annual Review of Neuroscience*, 31, 69–89. https://doi.org/10.1146/annurev.neuro.31.061307.090723 ✓
- Colgin, L. L., Moser, E. I., & Moser, M.-B. (2008). Understanding memory through hippocampal remapping. *Trends in Neurosciences*, 31, 469–477. https://doi.org/10.1016/j.tins.2008.06.008 ✓
- Tulving, E., & Thomson, D. M. (1973). Encoding specificity and retrieval processes in episodic memory. *Psychological Review*, 80, 352–373. https://doi.org/10.1037/h0020071 ✓
- Godden, D. R., & Baddeley, A. D. (1975). Context-dependent memory in two natural environments: On land and underwater. *British Journal of Psychology*, 66, 325–331. https://doi.org/10.1111/j.2044-8295.1975.tb01468.x ✓
- Smith, S. M., & Vela, E. (2001). Environmental context-dependent memory: A review and meta-analysis. *Psychonomic Bulletin & Review*, 8, 203–220. https://doi.org/10.3758/BF03196157 ✓
- Yonelinas, A. P., Ranganath, C., Ekstrom, A. D., & Wiltgen, B. J. (2019). A contextual binding theory of episodic memory. *Nature Reviews Neuroscience*, 20, 364–375. https://doi.org/10.1038/s41583-019-0150-4 ✓
- Stachenfeld, K. L., Botvinick, M. M., & Gershman, S. J. (2017). The hippocampus as a predictive map. *Nature Neuroscience*, 20, 1643–1653. https://doi.org/10.1038/nn.4650 ✓ (background)

**Consolidation, sleep, schemas**
- McClelland, J. L., McNaughton, B. L., & O'Reilly, R. C. (1995). Why there are complementary learning systems in the hippocampus and neocortex. *Psychological Review*, 102, 419–457. https://doi.org/10.1037/0033-295X.102.3.419 ✓
- Kumaran, D., Hassabis, D., & McClelland, J. L. (2016). What learning systems do intelligent agents need? CLS theory updated. *Trends in Cognitive Sciences*, 20, 512–534. https://doi.org/10.1016/j.tics.2016.05.004 ✓
- Wilson, M. A., & McNaughton, B. L. (1994). Reactivation of hippocampal ensemble memories during sleep. *Science*, 265, 676–679. https://doi.org/10.1126/science.8036517 ✓
- Girardeau, G., Benchenane, K., Wiener, S. I., Buzsáki, G., & Zugaro, M. B. (2009). Selective suppression of hippocampal ripples impairs spatial memory. *Nature Neuroscience*, 12, 1222–1223. https://doi.org/10.1038/nn.2384 ✓
- Frankland, P. W., & Bontempi, B. (2005). The organization of recent and remote memories. *Nature Reviews Neuroscience*, 6, 119–130. https://doi.org/10.1038/nrn1607 ✓
- Squire, L. R., Genzel, L., Wixted, J. T., & Morris, R. G. (2015). Memory consolidation. *Cold Spring Harbor Perspectives in Biology*, 7, a021766. https://doi.org/10.1101/cshperspect.a021766 ✓
- Diekelmann, S., & Born, J. (2010). The memory function of sleep. *Nature Reviews Neuroscience*, 11, 114–126. https://doi.org/10.1038/nrn2762 ✓
- Tse, D., Langston, R. F., Kakeyama, M., Bethus, I., Spooner, P. A., Wood, E. R., Witter, M. P., & Morris, R. G. M. (2007). Schemas and memory consolidation. *Science*, 316, 76–82. https://doi.org/10.1126/science.1135935 ✓
- Tse, D., et al. (2011). Schema-dependent gene activation and memory encoding in neocortex. *Science*, 333, 891–895. https://doi.org/10.1126/science.1205274 ✓
- van Kesteren, M. T. R., Ruiter, D. J., Fernández, G., & Henson, R. N. (2012). How schema and novelty augment memory formation. *Trends in Neurosciences*, 35, 211–219. https://doi.org/10.1016/j.tins.2012.02.001 ✓
- Wilhelm, I., Diekelmann, S., Molzow, I., Ayoub, A., Mölle, M., & Born, J. (2011). Sleep selectively enhances memory expected to be of future relevance. *Journal of Neuroscience*, 31, 1563–1569. https://doi.org/10.1523/JNEUROSCI.3575-10.2011 ✓
- Stickgold, R., & Walker, M. P. (2013). Sleep-dependent memory triage. *Nature Neuroscience*, 16, 139–145. https://doi.org/10.1038/nn.3303 ✓
- Tononi, G., & Cirelli, C. (2014). Sleep and the price of plasticity. *Neuron*, 81, 12–34. https://doi.org/10.1016/j.neuron.2013.12.025 ✓
- Lewis, P. A., & Durrant, S. J. (2011). Overlapping memory replay during sleep builds cognitive schemata. *Trends in Cognitive Sciences*, 15, 343–351. https://doi.org/10.1016/j.tics.2011.06.004 ✓

**Reconsolidation, tagging**
- Nader, K., Schafe, G. E., & LeDoux, J. E. (2000). Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval. *Nature*, 406, 722–726. https://doi.org/10.1038/35021052 ✓
- Nader, K., & Hardt, O. (2009). A single standard for memory: the case for reconsolidation. *Nature Reviews Neuroscience*, 10, 224–234. https://doi.org/10.1038/nrn2590 ✓
- Sevenster, D., Beckers, T., & Kindt, M. (2013). Prediction error governs pharmacologically induced amnesia for learned fear. *Science*, 339, 830–833. https://doi.org/10.1126/science.1231357 ✓
- Lee, J. L. C., Nader, K., & Schiller, D. (2017). An update on memory reconsolidation updating. *Trends in Cognitive Sciences*, 21, 531–545. https://doi.org/10.1016/j.tics.2017.04.006 ✓
- Kim, G., Norman, K. A., & Turk-Browne, N. B. (2017). Neural differentiation of incorrectly predicted memories. *Journal of Neuroscience*, 37, 2022–2031. https://doi.org/10.1523/JNEUROSCI.3272-16.2017 ✓
- Frey, U., & Morris, R. G. M. (1997). Synaptic tagging and long-term potentiation. *Nature*, 385, 533–536. https://doi.org/10.1038/385533a0 ✓
- Redondo, R. L., & Morris, R. G. M. (2011). Making memories last: the synaptic tagging and capture hypothesis. *Nature Reviews Neuroscience*, 12, 17–30. https://doi.org/10.1038/nrn2963 ✓
- Moncada, D., & Viola, H. (2007). Induction of long-term memory by exposure to novelty requires protein synthesis: evidence for a behavioral tagging. *Journal of Neuroscience*, 27, 7476–7481. https://doi.org/10.1523/JNEUROSCI.1083-07.2007 ✓
- Dunsmoor, J. E., Murty, V. P., Davachi, L., & Phelps, E. A. (2015). Emotional learning selectively and retroactively strengthens memories for related events. *Nature*, 520, 345–348. https://doi.org/10.1038/nature14106 ✓

**Forgetting, activation, interference**
- Ebbinghaus, H. (1885/2013). Memory: A contribution to experimental psychology (reprint). *Annals of Neurosciences*, 20. https://doi.org/10.5214/ans.0972.7531.200408 ✓
- Anderson, J. R., & Schooler, L. J. (1991). Reflections of the environment in memory. *Psychological Science*, 2, 396–408. https://doi.org/10.1111/j.1467-9280.1991.tb00174.x ✓
- Anderson, J. R., Bothell, D., Byrne, M. D., Douglass, S., Lebiere, C., & Qin, Y. (2004). An integrated theory of the mind. *Psychological Review*, 111, 1036–1060. https://doi.org/10.1037/0033-295X.111.4.1036 ✓
- Pavlik, P. I., & Anderson, J. R. (2005). Practice and forgetting effects on vocabulary memory: An activation-based model of the spacing effect. *Cognitive Science*, 29, 559–586. https://doi.org/10.1207/s15516709cog0000_14 ✓
- Petrov, A. A. (2006). Computationally efficient approximation of the base-level learning equation in ACT-R. In D. Fum, F. Del Missier & A. Stocco (Eds.), *Proceedings of the Seventh International Conference on Cognitive Modeling* (pp. 391–392). Trieste: Edizioni Goliardiche. http://alexpetrov.com/pub/iccm06/ ✓
- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks. *Psychological Bulletin*, 132, 354–380. https://doi.org/10.1037/0033-2909.132.3.354 ✓
- Underwood, B. J. (1957). Interference and forgetting. *Psychological Review*, 64, 49–60. https://doi.org/10.1037/h0044616 ✓
- Wixted, J. T. (2004). The psychology and neuroscience of forgetting. *Annual Review of Psychology*, 55, 235–269. https://doi.org/10.1146/annurev.psych.55.090902.141555 ✓
- Anderson, M. C., Bjork, R. A., & Bjork, E. L. (1994). Remembering can cause forgetting. *JEP: LMC*, 20, 1063–1087. https://doi.org/10.1037/0278-7393.20.5.1063 ✓
- Norman, K. A., Newman, E. L., & Detre, G. (2007). A neural network model of retrieval-induced forgetting. *Psychological Review*, 114, 887–953. https://doi.org/10.1037/0033-295X.114.4.887 ✓
- Wimber, M., Alink, A., Charest, I., Kriegeskorte, N., & Anderson, M. C. (2015). Retrieval induces adaptive forgetting of competing memories via cortical pattern suppression. *Nature Neuroscience*, 18, 582–589. https://doi.org/10.1038/nn.3973 ✓
- Anderson, M. C., & Hulbert, J. C. (2021). Active forgetting: adaptation of memory by prefrontal control. *Annual Review of Psychology*, 72, 1–36. https://doi.org/10.1146/annurev-psych-072720-094140 ✓
- Shuai, Y., Lu, B., Hu, Y., Wang, L., Sun, K., & Zhong, Y. (2010). Forgetting is regulated through Rac activity in *Drosophila*. *Cell*, 140, 579–589. https://doi.org/10.1016/j.cell.2009.12.044 ✓
- Berry, J. A., Cervantes-Sandoval, I., Nicholas, E. P., & Davis, R. L. (2012). Dopamine is required for learning and forgetting in *Drosophila*. *Neuron*, 74, 530–542. https://doi.org/10.1016/j.neuron.2012.04.007 ✓
- Hardt, O., Nader, K., & Nadel, L. (2013). Decay happens: the role of active forgetting in memory. *Trends in Cognitive Sciences*, 17, 111–120. https://doi.org/10.1016/j.tics.2013.01.001 ✓
- Davis, R. L., & Zhong, Y. (2017). The biology of forgetting—a perspective. *Neuron*, 95, 490–503. https://doi.org/10.1016/j.neuron.2017.05.039 ✓
- Richards, B. A., & Frankland, P. W. (2017). The persistence and transience of memory. *Neuron*, 94, 1071–1084. https://doi.org/10.1016/j.neuron.2017.04.037 ✓
- Ryan, T. J., Roy, D. S., Pignatelli, M., Arons, A., & Tonegawa, S. (2015). Engram cells retain memory under retrograde amnesia. *Science*, 348, 1007–1013. https://doi.org/10.1126/science.aaa5542 ✓

**Sparse coding, fly olfaction, hashing**
- Dasgupta, S., Stevens, C. F., & Navlakha, S. (2017). A neural algorithm for a fundamental computing problem. *Science*, 358, 793–796. https://doi.org/10.1126/science.aam9868 ✓
- Dasgupta, S., Sheehan, T. C., Stevens, C. F., & Navlakha, S. (2018). A neural data structure for novelty detection. *PNAS*, 115, 13093–13098. https://doi.org/10.1073/pnas.1814448115 ✓
- Lin, A. C., Bygrave, A. M., de Calignon, A., Lee, T., & Miesenböck, G. (2014). Sparse, decorrelated odor coding in the mushroom body enhances learned odor discrimination. *Nature Neuroscience*, 17, 559–568. https://doi.org/10.1038/nn.3660 ✓
- Hattori, D., et al. (2017). Representations of novelty and familiarity in a mushroom body compartment. *Cell*, 169, 956–969. https://doi.org/10.1016/j.cell.2017.04.028 ✓
- Olshausen, B. A., & Field, D. J. (1996). Emergence of simple-cell receptive field properties by learning a sparse code for natural images. *Nature*, 381, 607–609. https://doi.org/10.1038/381607a0 ✓
- Bloom, B. H. (1970). Space/time trade-offs in hash coding with allowable errors. *Communications of the ACM*, 13, 422–426. https://doi.org/10.1145/362686.362692 ✓
- Charikar, M. S. (2002). Similarity estimation techniques from rounding algorithms. *STOC '02*, 380–388. https://doi.org/10.1145/509907.509965 ✓

**Neuromodulation**
- McGaugh, J. L. (2004). The amygdala modulates the consolidation of memories of emotionally arousing experiences. *Annual Review of Neuroscience*, 27, 1–28. https://doi.org/10.1146/annurev.neuro.27.070203.144157 ✓
- Mather, M., & Sutherland, M. R. (2011). Arousal-biased competition in perception and memory. *Perspectives on Psychological Science*, 6, 114–133. https://doi.org/10.1177/1745691611400234 ✓
- Aston-Jones, G., & Cohen, J. D. (2005). An integrative theory of locus coeruleus-norepinephrine function. *Annual Review of Neuroscience*, 28, 403–450. https://doi.org/10.1146/annurev.neuro.28.061604.135709 ✓
- Hasselmo, M. E. (2006). The role of acetylcholine in learning and memory. *Current Opinion in Neurobiology*, 16, 710–715. https://doi.org/10.1016/j.conb.2006.09.002 ✓
- Yu, A. J., & Dayan, P. (2005). Uncertainty, neuromodulation, and attention. *Neuron*, 46, 681–692. https://doi.org/10.1016/j.neuron.2005.04.026 ✓

**Working memory, metamemory, prospective memory, events**
- Miller, G. A. (1956). The magical number seven, plus or minus two. *Psychological Review*, 63, 81–97. https://doi.org/10.1037/h0043158 ✓
- Cowan, N. (2001). The magical number 4 in short-term memory. *Behavioral and Brain Sciences*, 24, 87–114. https://doi.org/10.1017/S0140525X01003922 ✓
- Gobet, F., et al. (2001). Chunking mechanisms in human learning. *Trends in Cognitive Sciences*, 5, 236–243. https://doi.org/10.1016/S1364-6613(00)01662-4 ✓
- Tulving, E., & Schacter, D. L. (1990). Priming and human memory systems. *Science*, 247, 301–306. https://doi.org/10.1126/science.2296719 ✓
- Hart, J. T. (1965). Memory and the feeling-of-knowing experience. *Journal of Educational Psychology*, 56, 208–216. https://doi.org/10.1037/h0022263 ✓
- Brown, R., & McNeill, D. (1966). The "tip of the tongue" phenomenon. *Journal of Verbal Learning and Verbal Behavior*, 5, 325–337. https://doi.org/10.1016/S0022-5371(66)80040-3 ✓
- Koriat, A. (1993). How do we know that we know? The accessibility model of the feeling of knowing. *Psychological Review*, 100, 609–639. https://doi.org/10.1037/0033-295X.100.4.609 ✓
- Einstein, G. O., & McDaniel, M. A. (2005). Prospective memory: multiple retrieval processes. *Current Directions in Psychological Science*, 14, 286–290. https://doi.org/10.1111/j.0963-7214.2005.00382.x ✓
- McDaniel, M. A., & Einstein, G. O. (2000). Strategic and automatic processes in prospective memory retrieval: a multiprocess framework. *Applied Cognitive Psychology*, 14, S127–S144. https://doi.org/10.1002/acp.775 ✓ (pages from the Wiley record; Crossref has none)
- Zacks, J. M., Speer, N. K., Swallow, K. M., Braver, T. S., & Reynolds, J. R. (2007). Event perception: a mind-brain perspective. *Psychological Bulletin*, 133, 273–293. https://doi.org/10.1037/0033-2909.133.2.273 ✓

**Immune, collective, Physarum**
- Kaech, S. M., Wherry, E. J., & Ahmed, R. (2002). Effector and memory T-cell differentiation. *Nature Reviews Immunology*, 2, 251–262. https://doi.org/10.1038/nri778 ✓
- Victora, G. D., & Nussenzweig, M. C. (2012). Germinal centers. *Annual Review of Immunology*, 30, 429–457. https://doi.org/10.1146/annurev-immunol-020711-075032 ✓
- Dorigo, M., Maniezzo, V., & Colorni, A. (1996). Ant system: optimization by a colony of cooperating agents. *IEEE Trans. SMC-B*, 26, 29–41. https://doi.org/10.1109/3477.484436 ✓
- Theraulaz, G., & Bonabeau, E. (1999). A brief history of stigmergy. *Artificial Life*, 5, 97–116. https://doi.org/10.1162/106454699568700 ✓
- Tero, A., et al. (2010). Rules for biologically inspired adaptive network design. *Science*, 327, 439–442. https://doi.org/10.1126/science.1177894 ✓

**AI / LLM memory (for §5)**
- Liu, N. F., et al. (2024). Lost in the middle: how language models use long contexts. *TACL*, 12, 157–173. https://doi.org/10.1162/tacl_a_00638 ✓
- Park, J. S., et al. (2023). Generative agents: interactive simulacra of human behavior. *UIST '23*. https://doi.org/10.1145/3586183.3606763 ✓
- Zhong, W., et al. (2024). MemoryBank: enhancing large language models with long-term memory. *AAAI*, 38, 19724–19731. https://doi.org/10.1609/aaai.v38i17.29946 ✓
- Gutiérrez, B. J., et al. (2024). HippoRAG: neurobiologically inspired long-term memory for LLMs. *NeurIPS 2024*. arXiv:2405.14831 ✓
- Fountas, Z., et al. (2025). Human-inspired episodic memory for infinite context LLMs (EM-LLM). *ICLR 2025*. arXiv:2407.09450 ✓ (title corrected 2026-09-29)
- Behrouz, A., Zhong, P., & Mirrokni, V. (2025). Titans: learning to memorize at test time. arXiv:2501.00663 ✓ (v1 posted 2024-12-31)
- Saha, S. (2026). Delivery, not storage: cue-anchored working memory as a harness property for coding agents. arXiv:2607.20972 ✓ (cited in EDEN-MEMORY §11; abstract confirms the {path, symbol, semantic, event, temporal} triggers and "0 memory operations in 114 turns")
