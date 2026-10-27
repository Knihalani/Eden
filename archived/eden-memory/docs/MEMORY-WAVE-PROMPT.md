# Prompt: execute memory Wave M{N}

> **Superseded: history of the M1–M50 memory waves (September 2026).** The memory program now builds from [memory-ship/](memory-ship/): [ROADMAP.md](memory-ship/ROADMAP.md) orders the work, [DECISIONS.md](memory-ship/DECISIONS.md) wins every conflict, and [PROGRESS.md](memory-ship/PROGRESS.md) says what is done. The `/memory-wave` command this prompt served no longer exists; slices run with `/next` or `/slice`.

Used by `/memory-wave`. `{N}` is the pending wave from `docs/MEMORY-WAVE-STATUS.md`.

**CLOSED only. Zero leftovers.** Loop until every Done-when for M{N}.1–M{N}.4 holds **and** every finding is fixed. No pins, TODOs, follow-ups, or “later wave.” The Blocked template is the only exception (named external blocker the Done-when literally requires).

You are the orchestrator. You do not trust subagents. You do not trust your first patch. Adversarially review, probe the live inject path, and do not mark STATUS `closed` until the change helps (or an honest LOSS is filed) **and** the finding list is empty.

## 0. Mission

Execute all four parallel parts of Wave M{N} from `docs/MEMORY-WAVES.md`.

- Four parts in parallel (disjoint files or the named `src/index.ts` split). After merge, **you** fix every extra finding, including other memory files.
- Do not start Wave M{N}+1 as a scheduled wave. **Do** fix defects you find now, even if a later table also named them.
- M1: do not rewrite extract/ranker to green-wash characterization tests. Do fix every hole in M1’s own artifacts.
- M16: do not retune extract/ranker to green-wash M15. Lock evidence; M17+ flip pins.
- M37: **scoreboard checkpoint only.** Re-file official inject benches. Plan §7 walkthrough still green. Do **not** delete this command.
- M38–M49: **help path.** Remain-silent, diverse packet, provenance, this-task cue, incremental sleep, pin/forget in English, project identity, subagent share, import, help ledger, live coding holdout, first-session. Close on the help bar, not a MAB cell alone.
- M50: **ship a product that actually helps.** Plan §7 true on wrap+hook. Official inject scoreboard current. HELP.md helped > harmed, junk silent, continuity. Then delete this command. See slash command §4 and MEMORY-WAVES Wave M50. Do **not** delete at M20 or M37.

## 1. Required reading

1. `docs/MEMORY-WAVES.md` — Wave M{N}, locks, split, close table.
2. `docs/MEMORY-PLAN.md` §0, §3, §6, §7, §9, §10. `docs/MEMORY-COMPETITORS.md` when MN ≥ 9.
3. Cited Report §§ in `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md`.
4. Owner files as they exist now.
5. `docs/ROADMAP.md` §0, §4.9.
6. `docs/MEMORY-WAVE-STATUS.md`.

If a prior STATUS row is `pending`, that earlier wave is next.

## 2. Hard locks

- KaiavN git. No commit/push unless asked.
- No whatever harness. No gated UI.
- Any-agent, silent inject, one `AgentMemory`, fail-open.
- Do not: BrainMemory-as-product, retrieve@40 as MCC, EventQA-64k as Table 3, LoCoMo 92, k=40, label-strip, GraphRAG EventQA, Mem0 extract on ICL, hay in core, retrieve@5 loops, `memorable-cli`, MCP `memory_search` as default, cloud extract, 60ms CLI in front of inject, fail-closed 403.

## 3. Subagents

Four part-owners in parallel, then a **fresh** adversarial reviewer (not an author).

Each part brief: id, type, owner range, Report §§, Done-when quote, fail-open, no commit, **fix everything you find in your surface; do not file WAVE-FIX.**

You: diff every file, run tests yourself, revert harness/UI/commits, reject dual-API and hay. Relaunch skipped Done-whens. Do not weaken them.

Reviewer: falsify every Done-when; hunt wrap OpenAI, Anthropic, hook; fail-open; torn JSONL; secrets; encode/cue/hay; leftover identity; procedure schema-rename if MN ≥ 12; remain-silent vs Start briefing if MN ≥ 38. You reproduce every hit, **fix it**, add a test, re-run the reviewer until **zero** open items.

## 4. Probe

| Surface | Probe |
|---|---|
| Product | `openMemory` / `inject` / `injectBody` |
| OpenAI wrap | `packages/wrap/src/proxy.ts` |
| Anthropic wrap | `withKnowFactsAnthropic` |
| Hook | Submit / Start / Stop / PostToolUse as relevant |
| Persist | two writers, crash mid-write, reload |
| Fail-open | inject throw → messages unchanged |

Fix what the probe breaks. Official benches: run what the wave requires. “Did not run” is not closed unless it is the Blocked template.

## 5. Helping

Debug: before/after on the real failure. Check: honest artifact. Optimize: metric vs baseline. If it does not help, revert. Do not ship a no-op.

**Help bar (M38+):** close only if the next turn is more correct *or cheaper* because of inject, **or** inject was correctly omitted. Always-on junk is a fail even if a bench cell moved. Harmed note/procedure ids must be gone on the next cue.

## 6. Closed gate

- [ ] All four Done-whens have command + output.
- [ ] Finding list empty. No TODO / WAVE-FIX / deferred.
- [ ] Reviewer loop ended at zero open items.
- [ ] Inject probed. Fail-open true. No BrainMemory-as-product.
- [ ] Helping: before/after or honest LOSS.
- [ ] M16: evidence file + red pins only (no extract/ranker retune).
- [ ] M37: scoreboard filed; walkthrough still green; command **stays**. Do not treat M20 or M37 as the delete wave.
- [ ] M38+: help bar — next turn more correct or cheaper because of inject, or inject correctly omitted; harmed packets gone next time.
- [ ] M50: Plan §7 true on wrap+hook; walkthrough automated and green; audit + probe + tests + official inject scoreboard + HELP.md (slash command §4). Then delete.
- [ ] STATUS updated only after the above.

Unchecked → continue.

## 7. After close

Update STATUS. User-facing text is **only** the Closed or Blocked template in `.cursor/commands/memory-wave.md` §3. `Left:` must be `none` on Closed. M50 continues into that file §4, then deletes the command. M37 does not.
