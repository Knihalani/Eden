# 2. Long-horizon measurement

**Dated 2026-09-29. Run on this checkout, HEAD-era product (`openMemory` / `inject`).**

This is not the locked whatever 2k operator bench. That bench is **0 misses** for exact names in one global store. This exam asks: after **months to years of monorepo work**, with **folder-local truths**, does inject still help?

Runner: `bun benchmarks/memory-long-horizon/run.ts`  
Artifact: `benchmarks/memory-long-horizon/RESULTS.json`

---

## Protocol (inflated duration)

Wall-clock 18 months is not runnable in CI. Duration is **turn count**, which is what evicts memory and overwrites copulas.

| Knob | Value | Why |
|---|---|---|
| Workdays / month | 22 | Full-time coding agent |
| Turns / day | 12 | Observe + tool noise, not one chat |
| **18 months** | **4752** turns | Cap 2000 **must** drop history |
| **36 months** | **9504** turns | Same cap, twice the burial |
| **5 years** | **15840** turns | Cap 10k still trims; retrieve sees a fat index |
| Folders | `apps/web`, `apps/control`, `packages/cli`, `packages/wrap`, `src`, `benchmarks` | Sibling trees |
| Gold | Web: Auth Clerk, db postgres. Cli: Auth none, db sqlite. Pin: never commit `.env` | Folder conflict |
| Caps | **2000** (ship default) and **10000** (remember-more) | Eviction vs global LWW vs index fatness |
| Place | `open_files` on each observe/inject | What the hook actually has |
| Score | Packet strings after `inject`, not JSONL | |
| **Spawn-reload** | `openMemory` + inject, 11× | Claude hook is a **new process**; in-process p50 is the wrong SLO |

The bench passes `open_files: ["apps/web/app/login.ts"]` on `inject([{ role, content, open_files }])`. That is the wrap/hook **intended** shape. It is **not** what retrieve sees: `placePathsFrom` on a message array ignores `open_files`, and the Claude hook does not copy payload files onto the prompt at all. So these numbers are **global retrieve**, not “filename place cues vs directories.” Filename isolation was never in the packet path.

Gold is re-asserted at 50% of turns and again at the end of the write loop, so a miss is **not** “we forgot to write Clerk.”

---

## Results (this run)

### Cap 2000 × 18 months (ship default)

| | |
|---|---|
| Rows after trim | **2000** (4752+gold written, then cap) |
| JSONL | **211,194** bytes |
| `semantic.jsonl` | **527** bytes |
| Write (all observes) | **406 ms** |
| Inject p50 / p95 (in-process) | **0.013 / 0.029 ms** |
| Spawn parse p50 | **9.65 ms** |
| Spawn total p50 / p95 | **10.93 / 12.69 ms** |
| Heap delta / RSS | **6.96 MB / 122.4 MB** |
| Web auth → Clerk | **false** |
| Cli auth → none | **false** |
| Web db postgres / cli sqlite | **false / false** |
| Pin `.env` | **true** |
| Buried `op00042` | **false** |
| Chatter / xyzzy silent | **true / true** |
| Packet ≤8 / ≤900 | **true** |
| `scopedAuthOk` / `scopedDbOk` | **false / false** |

**Reading:** After a simulated year and a half, **live product facts are gone from the packet** unless they were pins. `semantic.jsonl` is still 527 bytes (the live copula file). Inject does not pack it. Silence still works. In-process inject is still cheap. The hook pays **~11 ms** to re-parse 2k JSONL.

### Cap 10000 × 18 months (keep the 4752 turns)

| | |
|---|---|
| Rows | **4759** |
| JSONL | **500,723** bytes |
| Spawn parse / total p50 | **22.5 / 25.6 ms** |
| Web auth → Clerk | **false** |
| Cli auth → none | **true** |
| Cli packs Clerk | **false** |
| Web db postgres | **true** |
| Cli db sqlite | **false** |
| Pin `.env` | **true** |
| Buried `op00042` | **true** |
| `scopedAuthOk` / `scopedDbOk` | **false / false** |

**Reading:** Raising the cap **does not** give folder memory. Last global `Auth is none` **tombstones Clerk for the whole repo** (place never reached the cue). Last global database write is postgres, so cli sqlite is dead. Buried operator names **do** survive when they are not evicted. Hook cost is already **~26 ms**.

### Cap 2000 × 36 months and × 5 years

Same shape as 18 months. Rows stuck at **2000**. JSONL **~211–213 KB**. Pin `.env` **true**. Scoped auth/db **false**. Buried operator **false**. Spawn total p50 **~9.6 ms** (parse is capped with the file). Write time grows (~1.0 s at 36 mo, ~2.2 s at 5 y) because observe still walks 9k–15k turns before trim.

**Reading:** Extra years at the ship cap do not make the packet worse in a new way. The cap already forgot the product at 18 months. Time past that is free disk churn.

### Cap 10000 × 5 years (fat index)

| | |
|---|---|
| Rows | **10000** (15840 written, then cap) |
| JSONL | **1,064,495** bytes (~1.06 MB) |
| `semantic.jsonl` | **527** bytes (unchanged) |
| Write | **2333 ms** |
| Inject p50 in-process | **0.004 ms** |
| Spawn parse p50 | **45.8 ms** |
| Spawn total p50 / p95 | **50.1 / 53.1 ms** |
| RSS | **300.6 MB** |
| Web Clerk / cli none | **false / false** |
| Web postgres / cli sqlite | **false / false** |
| Buried `op00042` | **false** |
| Pin `.env` | **true** |
| `scopedAuthOk` / `scopedDbOk` | **false / false** |

**Reading:** A 10k cap over 5 years **evicts the buried needle** and, worse, **fails to pack even the trailing Auth/db copulas**. That is retrieve collapsing under posting-list size / `df≥80` / 12-needle rules — not only eviction. Spawn-reload is **50 ms**, still 3× faster than Mem0 search p50 **148 ms**, and **50× over** the &lt;1 ms Submit bar.

---

## Contrast: locked 2k operator bench

Whatever scale (`2000` identical “operator opN lives in city cN”, Clerk, postgres→sqlite): **0 misses**, **~0.02 ms** in-process, **~93 KB**. That world has **one** auth and **one** database. It cannot see the coding-agent failure. It also never measures spawn-reload.

M49.2 BASELINE 2k inject p50/p95 **24.5 / 28.4 ms** is a different path (full inject with lanes). Do not mix that number with this runner’s 0.013 ms in-process figure. The number that matches Claude Code is **spawn total**.

---

## What this implies

1. **Long-term at cap 2000 = forget unpinned JSONL copulas.** Pins stay. SemanticStore still holds live `(s,p,o)` in **527 bytes**. Inject ignores that file for this cue. Cheap win: pack live scoped copulas from semantic, never parse 15k episodes to remember Auth.
2. **Long-term at a bigger cap = remember episodes, still one world-model, then the index itself fails.** Sub-memory is not “more rows.” At 10k × 5 y, more rows **hurt** retrieve.
3. **Place never reached retrieve on this exam.** Fix `placePathsFrom` / hook Submit first, then directory filter. Basename-only would still collide; the current miss is stronger: **no place at all**.
4. **Persist drops `at`.** A spawn-reload LWW is file order, not wall-clock. In-process 18-month cap-10k “cli none wins” will not be the same after a real hook restart.
5. **In-process inject ms is not the blocker.** Spawn **parse** is. The hook also parses the **full transcript** then slices 40 — that cost is not in this runner.
6. **Silence still holds** under 5 years of junk. Keep that.
7. **RSS grew with write-loop heap, not with the 2k file.** 5 y × cap 2000 RSS 266 MB vs 10k file RSS 301 MB. Do not load cold into the hook process.

---

## How to re-run / extend

```bash
bun benchmarks/memory-long-horizon/run.ts
```

Next measurements when sub-memory ships (same runner, new assertions):

- `scopedAuthOk` / `scopedDbOk` must flip true at cap **2000** after 4752, 9504, and 15840 turns.
- Sibling leak stays false.
- Pin inherit stays true in both trees.
- Root cue with **no** `open_files` does **not** pack folder copulas (inherit off).
- **20k cold / 500 hot:** spawn-total p95 **&lt;1 ms**, live copulas still present.
- Sleep every 32 turns × 150 cycles: aliases for paraphrase, no Submit embedder.
- Multi-session: parent vs `parent--child` vs **directory** (three axes; do not conflate).
- How-to: a non-`flake` “how do I” cue in `apps/web` packs the web procedure only.

Do not replace the locked whatever harness with this file. Different exam.
