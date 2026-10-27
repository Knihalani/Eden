# BLANK-C3: a retrieval design built from scratch

Code: `methods_blank.py`. Registry: `blank` (default), `blank-lsa`, `blank-abs`, `blank-raw` (all signals off, for ablations). Pure Python and numpy. No model calls anywhere. Each query takes about 1–5 ms.

## Mechanism

**Sleep time (constructor).** It reads only store rows and raw stream text, and every structure is gated by time.
1. **Statement compiler.** Each row is traced to the stream event it was copied from (≥ 0.7 of its tokens), which gives a source type. Rows from notifications, peer messages and triggers are dropped. The rest are split into clause units on sentence breaks, bullets, `;`, `—`, "also" and "btw". Each derived row keeps its source row's `t`. Each unit gets a *worth* score: a source prior (human 1.0, compact 0.6, tool 0.55, assistant 0.5) multiplied by statement cues (rule words, fact words, digits, proper nouns), minus a penalty for questions and imperatives. Code-like units and template boilerplate (≥ 4 near-identical copies) are dropped. Oracle rows are kept whole.
2. **Encoding context** (`kappa`). Each unit remembers the turn it was stated in: the prompt, plus the agent's replies. A later cue that matches that situation scores the unit even when it shares no words with the unit (Tulving's encoding specificity). This context is used only after that turn has ended.
3. **Episode feedback** (`beta`). Every past turn is a document: the prompt plus what the agent then did (tools, outputs, replies). For a new prompt, the method finds the 5 most similar earlier prompts and adds what was done after them as weighted expansion terms. For example, "put the pr up" pulls in `gh`.
4. **Latent episode space** (`blank-lsa`, `gamma`). A randomized SVD over turn × term tf-idf. It is refit every 10 sessions on turns that ended before the checkpoint, so it never sees the future.

**Hot path (`packet`).**
- **Class gate.** Notifications and peer messages are always silent.
- **Prompt gate.** These turns get no packet: acks and small talk, general-knowledge questions ("difference between", "how does", "unrelated", "tl;dr"), and pastes of more than 12 lines.
- **Statement-turn penalty.** Turns that *give* facts score lower: "fyi", "for the record", "from now on", "decided" (×0.35), and prompts with ≥ 3 tokens never seen before in the stream (×0.6).
- **Score per unit.** Lexical idf overlap is damped for tokens the user types all the time (`qidf`), so a kid's name or "invoice" alone counts for little. Then add context, feedback and LSA terms. Multiply by **novelty** (share of the unit not already in the context window or the prompt, cut at 0.35), by worth, and by the gate.
- **Budgeted firing** (`rho=0.15`). A turn fires only if its evidence (sum of its top-3 scores) beats the 85th percentile of earlier turns' evidence. This makes the packet rate calibrate itself to any user or store instead of relying on an absolute threshold.
- **Selection.** Of near-duplicates, keep the newest (supersession). Keep bullets that score ≥ 0.5× the top bullet, and at most 4.

## Dev results (score.py --split dev --ci, exactly as printed)

| world/store | system | recall | proactive | precision | silence (human) | nonhuman sil | trigger rec / sil | tokens | stale | recall CI95 |
|---|---|---|---|---|---|---|---|---|---|---|
| code/write | blank | 0.0364 | 0.0 | 0.0057 | 0.7768 | 1.0 | – | 32.3517 | 0.049 | [0.0, 0.0962] |
| code/write | blank-lsa | 0.0455 | 0.0 | 0.0083 | 0.7768 | 1.0 | – | 31.0409 | 0.0291 | [0.0, 0.1111] |
| code/oracle | blank | 0.2242 | 0.0 | 0.0644 | 0.8542 | 1.0 | – | 12.7826 | 0.0 | [0.1202, 0.3367] |
| code/oracle | blank-abs | 0.1242 | 0.0 | 0.0879 | 0.8929 | 1.0 | – | 4.6714 | 0.0 | [0.0472, 0.2191] |
| life/write | blank | 0.0738 | 0.087 | 0.0166 | 0.8109 | 1.0 | 0.0 / 0.6471 | 27.1949 | 0.0593 | [0.0301, 0.126] |
| life/write | blank-lsa | 0.0802 | 0.0435 | 0.0154 | 0.7767 | 1.0 | 0.0 / 0.6471 | 32.6337 | 0.098 | [0.0294, 0.1315] |
| life/oracle | blank | 0.0759 | 0.0435 | 0.0287 | 0.8612 | 1.0 | 0.0385 / 0.8235 | 14.967 | 0.0 | [0.0282, 0.1299] |
| life/oracle | blank-lsa | 0.1266 | 0.087 | 0.0312 | 0.829 | 1.0 | 0.0385 / 0.8235 | 22.7118 | 0.0 | [0.0625, 0.1919] |

For reference, `eden` (the product's packets, same dev events) scores: code recall 0.0909, silence 0.1042, 61.7 tokens; life recall 0.0443, silence 0.0503, 74.5 tokens.

On life/write, `blank` beats the product on recall (0.0738 vs 0.0443) at a silence of 0.81 instead of 0.05. On code/write, it trades recall (0.0364 vs 0.0909) for silence (0.78 vs 0.10). Both worlds are far from "perfect".

## What I tried (dev, in-process harness identical to score.py)

- **The ranking ceiling is the bottleneck, not the gate.** If the method fires on every turn (τ ≈ 0), the best oracle recall@4 is about 0.26–0.29 on code (`kappa=0.7`: 0.2606; lexical + feedback + frames: 0.2818) and 0.35 on life (`kappa=0.5`: 0.3502). On write it is 0.07–0.15. On the write store, about half the needed items have no candidate that shares even one token with the prompt. Proactive needs (`date picker` → date-fns, `order dinner` → diet) are almost unreachable without world knowledge.
- **Encoding context** is the largest single gain on oracle (code 0.1879 → 0.2909 with `kappa=1`, life 0.2869 → 0.3502 with `kappa=0.5`, at τ ≈ 0). On write it hurts, because noisy units stated in the same turn share the context.
- **LSA:** with full-stream (leaky) fitting it gave +0.09 on code. Leak-free checkpoints keep about half of that gain, and the effect is inconsistent across worlds.
- **Episode feedback** gives +0.0–0.1 and is noisy.
- **Generic frame ontology** (food → diet and allergies, deps → package manager, …): roughly neutral.
- **Salience by cross-session recurrence:** neutral.
- **Finer clause splitting** lowered write recall (0.12 → 0.07): fragments stop covering their item.
- **Showing neighbour or whole-row text** won back about +0.02–0.04 recall, at 2× the tokens.
- **Gate cues are clean** (dev-label diagnostics): each of the general-question, social and paste cues fires on at most 1 need turn per world, against 14–43 negatives. The STATE cue catches about 35% of fact-stating turns. The evidence score alone has an AUC of only 0.68–0.80.
- **Budgeted firing versus an absolute threshold:** budgeted firing reached silence ≥ 0.85 on oracle in both worlds. The absolute threshold either over-fires on life (0.65) or starves code.

## Caveats

- Dev has 55 code and 79 life need turns, so one turn moves recall by about 0.015 and most differences above sit inside the CIs.
- I read dev labels for aggregate diagnostics and a handful of examples. The gate regexes and the frame table are hand-written and generic, but they carry some risk of fitting to dev. I did not run the test split.
- No subagents were used (no agent tool was available).

## Next

The lexical and statistical family tops out at about 0.3 recall@4 on clean rows. Two things would move the numbers:
1. A sleep-time model that writes, for each memory, the situations that need it (doc2query over encoding contexts). These would be indexed exactly like `ctx` here, so the hot path stays model-free.
2. A sleep-time compiler that turns write-path episodes into clean statements. The write → oracle gap is 3–6× on recall.
