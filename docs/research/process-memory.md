# The per-process memory floor (2026-11-13, D1781: finding, nothing shipped)

The router runs one Bun child per core (D113, D163), so whatever one server process holds before it has any user is
paid N times. The question: can a child's floor drop by at least 10 MB or 15% (lazy loading of rarely used parts,
read-only data shared across processes, lab-only code kept out of the server), with first-request latency within
noise and identical outputs? Measured first; no lever cleared the bar, so nothing was built. The measuring scripts
were scratch (not committed); this note says what each did.

## The floor

`main.ts` started as one router child runs it (`EDEN_PROCESSES=1`, `EDEN_DEV=1`, no persistence, no sources,
`PORT=0`, `env -u BUN_OPTIONS`), memory read from `/proc/<pid>/status` and `smaps_rollup`; Bun 1.4.4, 4 cores, a
machine shared with other work (load average 5-15).

| | RSS MB | anon MB | file MB |
|---|---|---|---|
| idle, 3 s after `listening` (3 runs) | 55.9-56.5 | 21.6-22.0 | 34.4-34.5 |
| the same with `--smol` (3 runs) | 55.2-55.7 | 20.7-21.2 | 34.5 |
| after two observes for one new user and 17 s idle | 58.7-58.9 | 22.6-22.8 | 36.1 |
| the same with `--smol` | 58.3-58.8 | 22.2-22.6 | 36.2 |

First request (an observe for a new user) 21.4-27.6 ms, 25.7-34.3 with `--smol`. `--smol` saves under 1 MB here:
the heap is small; the floor is not heap. About 34 MB of the RSS is file-backed, almost all Bun's own executable,
shared by every child on the machine (PSS, which divides shared pages, read 24-47 MB and moved with whatever other
Bun processes ran). What a child holds on its own is the anonymous part, about 22 MB.

## Where it goes

One process importing what `main.ts` imports and taking its startup steps in order, a full GC before each reading
(`Bun.gc(true)`), the RSS and anonymous memory each step adds (two runs, the second with `--smol`, within 0.4 MB):

| Step | RSS | anon |
|---|---|---|
| Bun with nothing imported | 21.2 | 4.0 |
| `@eden/protocol`, `@eden/primitives` (the first modules: the loader and transpiler's own start) | +7.5 | +3.5 |
| `@eden/redact` modules | +2.2 | +1.1 |
| `@eden/sources`, `@eden/llm` | +1.1 | +1.1 |
| `@eden/engine` modules | +3.9 | +3.0 |
| `@eden/graph` | +0.3 | +0.1 |
| the server's modules (router, cluster, S3 store, ops, http, config) | +0.9 | +0.7 |
| the source map's file opened | +1.4 | +0.2 |
| the turn gate (`turnGate()`, 1.59 MB of weights) | +2.6 | +1.8 |
| the glossary's prefix (`warmGlossary`) | +4.2 | +1.4 |
| `buildPartner` | +0.2 | +0.1 |
| the secret gate (`warmGate`) | +14.6 | +10.6 |
| (later) the glossary's lexicons, on a non-English request | +2.9 | +2.7 |

Module code in all is about 15 MB of RSS and 9.5 MB anonymous, spread over every package; the server-only modules a
child does not need (router, cluster, S3) are 0.9 MB, and no lab code is imported by the server (D1700 keeps it out
of the image too). Bun's runtime transpiler cache is already used by default: disabling it or pointing it at a fresh
directory moved nothing.

The secret gate is the one large piece. Split (`secretRules`, its checks, `warmGate`'s per-rule warm): parsing every
rule's own allowlist regex to check it is supported (`checkAllowlists`, 49 regexes, 6.7 ms) added +10.9 MB RSS and
+4.6 anonymous, mostly first-use costs (the parser's code, Unicode case tables for `(?i)` classes) and allocator
high water, since the heap after GC grew only 0.3 MB; building the 235 rules +3.0 / +2.5; the per-rule warm
(`rule.warm()`, every gitleaks regex compiled and run once on "") +5.4 / +4.1.

## The levers, measured

- **No per-rule warm (rules compiled on their first keyword hit, as `gitleaksRule` does without `warmGate`):** idle
  RSS 52.9-53.3 against 55.9-56.5 (−3 MB, 5%), after the warm-up 55.8-55.9 against 58.3-58.8. On the pipeline
  workload's texts (226 event texts through `sanitizeForStore`) the gap after the texts was 1.5 MB (78.0 against 79.9
  MB in a process holding the workload): what is not warmed is mostly compiled again by real traffic.
- **Also no `checkAllowlists` at startup (the check moved to a test):** idle 51.1-51.5 (−5 MB, 9%), after the warm-up
  54.0-54.4 (−4.5 MB, 8%). The global allowlist and the rules that run still parse theirs, so part of the first-use
  cost comes back with traffic. First request 28.4-31.5 ms against 21.4-27.6 (the moved compile).
- **The turn gate and the glossary through `Bun.mmap` (shared page cache):** the gate keeps its int8 weights as views
  of the file's bytes, so a mapped file would hold them once a machine instead of once a process: 1.6 MB (and the
  glossary 0.3 MB of prefix, 2.2 MB of lexicons once read) moved from anonymous to shared file pages. RSS does not
  change (a mapped page counts in each process's RSS); summed over 4 children it would save about 5-12 MB a machine.
  Not built: under the bar per process, and a mapped file changed under a running process (a deploy that rewrites the
  file in place) changes its weights, where `readFileSync` keeps the bytes it read.
- **Lab-only and router-only code:** none of the first is loaded; the second is 0.9 MB.

Together the first two levers reach about 5 MB (9%) at idle and less once traffic compiles the rules, short of 10 MB
or 15%, and they move cost onto the first requests the gate warm-up exists to protect (packages/server/CLAUDE.md,
"Warm the gate before serving"). Kept as it is.

## What would move it

The floor is Bun's runtime (21 MB, 17 of it the shared executable), the modules (about 15 MB) and the secret gate
(about 15 MB). A process count below the core count, or several users' work per process, is the lever on the
machine's total; within a process, a gate whose rules are compiled ahead of time into data (the D1705 automaton for
every rule, not only the allowlists) would be the next measurement.
