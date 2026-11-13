# Inference and tokens: where Eden's model tokens go, and what is left to cut (2026-11-13)

D1740, D1741, D1742. A survey of every model role for output-invariant cuts (same bytes the model needs, fewer it
does not, fewer calls whose answer is known, faster plumbing) and for model-facing ones, built as trials.

**What could be measured here.** No paid call: OpenRouter refuses `anthropic/*` from this sandbox, and the Anthropic
key has no credit (its token-counting endpoint answers "credit balance too low" too, tried once). So every token
figure below is either **measured** (a recorded ledger) or an **estimate [EST]** from characters at a ratio
calibrated on a recorded ledger, said for each.

## 1. Calls a task, and what is in each call

Roles in the shipped default (`DEFAULT_CONFIG`):

| Role                          | Calls                                                 | Where it runs                     |
| ----------------------------- | ----------------------------------------------------- | --------------------------------- |
| Push check                    | 0.93 a task on the 1:1:8 mix (F7); 0.98 in the dump   | per request, on the request path  |
| Cards (with intent requests)  | about 16 items a call (funnel: 1,589 items, 99 calls) | background, once an item content  |
| Reader                        | 0 (`pushCandidates` skips `readAsk`, D236)            | not called by the default         |
| Judge                         | lab only (the servers wire none)                      | -                                 |
| Agent's first call (proxy)    | about 0.46 aborted a task under `speculate` (D1273)   | the tenant's bill, not Eden's     |

**The dump.** The funnel's default on train, seeds 41–42, with `--neutral` (1,152 tasks), its check wired to an empty
replay cache so every call fails open after its prompt is built, `--check-dump` recording each check's input
(`bun run funnel --jobs 1 --allow-misses -- --check replay --check-cache EMPTY --check-dump F --neutral`, $0):
1,127 checks, one a task, every one with a rule sheet (48.8 rules a check, 4.8 of the 14.6 pool items sent as
pointers), no two with the same `checkKey`.

**Calibration.** The diag ledger (`.local/diag/ledger.jsonl`, 2026-11-12, Anthropic direct, 465 check calls with no
sheet): every call read or wrote exactly 1,185 cached tokens, the instructions (`CHECK_SYSTEM` and the transport's
JSON line: 3,919 characters), so prose runs **3.31 characters a token** on Haiku 5.5. Those calls averaged 2,550 input
tokens, so their request and pool were 1,365 tokens; the same pools without pointers are about 3,550 characters in the
dump, **about 2.6 characters a token** for fenced item text. D239 measured that quoted attributes tokenise far better
than that (23% of the characters, 2% of the tokens), so the sheet's lines are given as a range, 2.6–3.0.

## 2. The push check, part by part [EST unless marked]

| Part                                       | Characters | Tokens               | Cached?                     | $ a check (Haiku 5.5 list) | Share |
| ------------------------------------------ | ---------: | -------------------- | --------------------------- | -------------------------: | ----: |
| Instructions (`CHECK_SYSTEM` + JSON line)  |      3,919 | 1,185 (measured)     | read, global                |                   0.000012 |    3% |
| Sheet head (`SHEET_HEAD`)                  |      1,534 | about 464            | 1 h, per user               |       with the sheet below |       |
| Sheet rules (48.8 lines; fences 3,052)     |      7,146 | 2,380–2,750          | 1 h, per user               |                            |       |
| Sheet in all, at F7's spacing (below)      |      8,680 | 2,840–3,210          | 0.569 of uncached           |          0.000162–0.000183 |   46% |
| Request, day, pool, `<in-items>`           |      2,934 | about 1,130          | no                          |                   0.000113 |   31% |
| of which item fences                       |      1,087 | (D239: few tokens)   |                             |                            |       |
| Reply (compare-first)                      |          - | 145 (measured, diag) | -                           |                   0.000073 |   20% |
| **A check**                                |     15,476 | about 5,300          |                             |              **≈ 0.00037** |       |

The sheet's price a check is `packages/sim/lab/f7/sheet-cache.py`'s model (a heavy user, 16 requests a day at random
over 7.3 active hours, 1–4 sheet changes a day): reads at 0.1x on about three checks in four, writes at 2x on the
rest; in units of the sheet sent uncached that is **0.569**, so the cache saves 43%, not 90%. Times 0.93 checks a
task: **about $0.34 per 1,000 tasks**. F-wave final's $0.17 (its 1-hour row less the agent alone) priced the sheet at
four characters a token; at Haiku 5.5's measured 3.31 for prose and about 2.6 for fenced text it is about 45% more.

**Achievable, and what blocks it:**

| Lever                                                                     | $ a check                     | Status                                                                 |
| ------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| Shipped route before D1790 (OpenRouter, no breakpoints)                   | ≈ 0.00060 (all input uncached) | breakpoints on by default since D1790, with a fallback                |
| Lab transport / D1196 promoted (the table above)                          | ≈ 0.00037 (−39%)              | trial, the owner's OpenRouter probe                                    |
| Sheet appended, one block a rule (`pushCheckSheetAppend`, D1741)          | ≈ 0.00032 (−14% more)         | rejected unscreened (D1741); code on `claude/check-sheet-append`       |
| Every sheet read from cache (ceiling)                                     | ≈ 0.00021                     | not reachable: a user's first check of a day is always a write         |
| An oracle skipping the 43% of calls that end silent (D930, D931)          | −43% of calls                 | unreachable without the model (D1272, D1274)                           |

## 3. The other roles

**Cards and intent** (measured, diag ledger, 238 calls): 2,770 input tokens (1,327 the cached instructions, which
carry "Today is …", so one write a tenant a day), 1,361 output, **$0.00085 a call; output is about 80% of it**
(D1052). Items with the same content share one card (`reused`, `sentenceReused`; funnel: 9,124 and 102 reuses for
1,589 sent), and a user's lanes share what is in flight (`UserCards.flying`). The reply's own levers were measured:
a compact reply (positional arrays) −26.7% against a −30% bar, larger batches the same a item (D1052). The example
reply's `"limit":null,"unit":""` is copied into most cards (about 23 characters a card); dropping it from the example
is a model-facing change of the same family as D1052's compact reply and was not built. The replay files key cards by
item content and form (`<hash>:f3`), not by the prompt's bytes, so the funnel cannot see a card prompt change either
way: any card wording change needs a paid card screen.

**Reader:** no call in the default. **Proxy `speculate`:** an aborted call is billed its input (D1273, about
+$0.045 per 1,000 tasks [EST]); the abort happens exactly when the check says yes, so no cheaper form keeps the
speed without knowing the check's answer early (D1272, D1274).

## 4. The trial: the sheet appended (`pushCheckSheetAppend`, D1741)

Rejected on 2026-11-13 without its screen: no paid calls are left (D1741). The code is on the branch
`claude/check-sheet-append`; the screen below is the way back.

Why the sheet is the lever: its writes, not its reads. Newest first, a card that lands mid-day goes on top and the
next check rewrites all 2,840–3,210 tokens at 2x. With the switch the same rules (chosen and deduplicated as now) are
listed in the order their cards were made, one text block a rule, the breakpoint on the last rule, no count in the
opening tag and the closing tag after the breakpoint. A grown sheet's blocks then start with the earlier sheet's,
byte for byte (`push-check-append.test.ts` checks it on `anthropicBody`'s output), and Anthropic's breakpoint looks
back up to 20 blocks for the last entry written, so the next check reads the old rules and writes only the new ones.
An expiry (an `end` before the user's day) changes the sheet only at a day's first check, which writes anyway.

Modelled on F7's three spacings (`packages/sim/lab/f7/sheet-append.py`, the same Monte Carlo as `sheet-cache.py`; a change writes the
whole sheet on main, the new rules plus a read of the old with the switch; 20 or more new rules at once write it all):

| Spacing                       | Changes a day | Main (× sheet uncached) | Appended | Sheet cost cut |
| ----------------------------- | ------------- | ----------------------: | -------: | -------------: |
| random over active hours      | 1–4           |                   0.569 |    0.395 |            31% |
| random over active hours      | 4–10          |                   0.817 |    0.402 |            51% |
| lab (10 minutes)              | 1–4           |                   0.500 |    0.225 |            55% |
| bursty                        | 1–4           |                   0.489 |    0.437 |            11% |

On the cautious row: about −$0.000052 a check, **−14% of the check, about −$0.05 per 1,000 tasks [EST]**. The prompt
holds the same rules and the same characters less the count (15,476 against 15,466 a check in the dump; every one of
the 1,127 checks the same rules, every one in another order). That is model-facing: rule order and numbering change,
and the sheet arrives as many blocks. It does not change the funnel (no checker wired: 322/384, 294/384 either way).

**Pre-registered rule for the paid screen** (to be committed before the run): train seeds 41–42 with `--neutral`, the
check live on Haiku 5.5 (Anthropic direct, lab transport) for both arms over the same pools,
`bun run funnel --jobs 1 -- --check live --check-cache C --check-dump D --neutral` against the same with
`--set '{"pushCheckSheetAppend":true}'`; promote when the planted items the check names on hidden tasks are within
−1 of main's and look-alikes named on control tasks and items named on neutral tasks are not up by more than 1, and
`pushCheckSheet`'s rules named move by no more than ±10%; delete otherwise. Cost: about 2 × 1,127 checks at
$0.00037–0.0006 (cold cache) ≈ **$1.0–1.4**. A second, cheap probe reads `cache_creation_input_tokens` on two checks of
one user before and after one card lands (≈ $0.002). Subagent answers cannot stand in (D1104: check wording and order
are exactly what they do not carry).

## 5. Rejected or not built, with the reason

- **Compact item and rule fences.** D239 measured the reader's: attributes are 23% of the characters and 2% of the
  tokens. The sheet's fences are the same shape (3,052 of 7,146 characters); not proposed again.
- **A shorter reply, a stop at the first no, dropping `on`.** D822, D1191: dead ends.
- **A per-user memo of judged pools across sessions.** 0 repeated `checkKey`s in 1,127 checks; within a session the
  kept checks already answer a second pass (`checkPush`). No evidence of repeats to build for.
- **Skipping a single-item or empty pool.** An empty pool already makes no call; no pool in the dump had fewer than
  2 items, and one item's answer is not known without the model.
- **Singleflight for identical concurrent calls.** A session shares a running check by key; card lanes share
  sentences in flight; across sessions no two checks were identical.
- **The transport's JSON line repeated after `CHECK_SYSTEM`'s own** (about 15 cached tokens, < 0.5%); model-facing.
- **Output caps and stop sequences for the check.** The compare-first reply lists rejections on purpose (no stop);
  its cap (620 with a sheet) binds only on a broken reply; `max_tokens` is not billed.
- **Streaming against not for short replies, keep-alive.** The lab streams for its TTFT figure, OpenRouter's route
  does not; Bun's `fetch` keeps connections alive. Nothing to change without a live timing.
- **`readSse`.** Shipped (D1740) as plumbing: no gain on the roles' streams, 57x on one 4 MB event.

A lab bug fixed with the trial: `check-dump.ts` kept each reply by the first user message, which with a sheet is the
sheet itself, the same for all of a user's checks, so a dumped row could carry another check's reply; it now keys by
the last (the request's). `hidden-funnel.ts`'s `--check-log` still logs the first user message as `prompt` (the
sheet, with a sheet); not changed here.
