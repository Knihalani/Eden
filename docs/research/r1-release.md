# R1: release readiness of tonight's merges (2026-11-11)

Scope: every merge into `main` from 5026ba512 to 3b54c433 (PRs #244–#269). The audit concentrated on #267 (`pushGate`,
D1014, D1015), #268 (`cardsRequestsFix`, D1060–D1063), #263 and #265 (deploy kit, D990–D997) and #254 (`pushCheck`
S, `pushIndirect`). Branch `claude/r1-release`, decision D1070. No paid model call, no Modal, heldout19 not read.
Every number below comes from a command run in this session on a 4-core container (other work running beside it:
read p50 differences under ~10% as noise).

## Findings

| # | Where | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | `persist-shared.ts` `enqueue`, `start` | After a release passed its deadline, the old owner is fenced and its forget's delete is skipped, but its own put of the user still queued (or waiting to retry) ran later, after the new owner's delete: a forgotten user came back in the store (confirmed in a scratch test, 300 ms put delay) | medium (privacy) | fixed: a fenced delete drops the name's queued job; a retry re-checks the fence. A put already on the wire still lands (one store call's window) |
| 2 | `persist-shared.ts` `absent` | One name per user ever missed or deleted, cleared only on a membership change: unbounded on a single machine with a store | medium | fixed: `MAX_ABSENT` 100,000, then starts over |
| 3 | `router.ts` `/readyz` | One crashed child made a machine's `/readyz` 503; the single box's Caddy (`health_uri /readyz`, one upstream) then held every user's requests for 20 s and failed them | medium | fixed: plain `/readyz` ready while any child is up; `?all=1` keeps D994's rule, and the cluster router probes it |
| 4 | `ops.ts` `cluster` | A release still awaiting hand-offs, finishing after a newer `drop`, wrote its older table back | low | fixed |
| 5 | `router.ts` | A child restarted after a membership had no table (no fence, every bucket writable) until the next membership | low | fixed: the last membership is replayed to a (re)started child before it serves |
| 6 | `main.ts`, `ops.ts` | A throw in `Ops.wrap` (a cut-off body in the fence, a 40,000-node membership) was Bun's default 500 | low | fixed: `wrap` answers 503, `main.ts` has a 503 `error` handler, a membership past 32,767 nodes is 400 |
| 7 | `router.ts` `stopChildren` | SIGKILL exactly at the grace the child's steps fill (`persistLive` checks its deadline between users only) | low | fixed: 1.25x the grace (compose stop periods still cover router drain delay + 0.4 + 1.25 grace) |
| 8 | `cluster.ts` `forward` | No timeout on a forwarded request: a hung node held router requests for ever | low | fixed: 60 s, then 503 |
| 9 | `main.ts` | Persistence problems found on first read were logged by a 60 s unref'd timer only, never at shutdown | low | fixed: flushed at shutdown |
| 10 | `cluster.ts` / D992 | A machine whose child keeps failing is dropped by the cluster router (drop mode): its users lose live and warm state since their last compact freeze | design | not changed: D992's chosen trade (a child that cannot start is better served elsewhere); a crashed child restarts in ~1 s, inside the 3 probes |
| 11 | `persist.ts` | A wrong `EDEN_PERSIST_KEY` starts the server and deletes every blob (logged as `N discarded (key)`) | design | not changed: DEPLOY.md documents a new key as discarding every persisted user (and rotation after a leak needs it); the state re-syncs from sources |
| 12 | `users.bench.ts` | Thawing 300 warm users at once showed one 356–381 ms event-loop stall in 2 of 3 runs (27 ms in the third); the thaw itself is sliced, so most likely a major GC | low | not fixed: intermittent, outside the reviewed PRs' code (D862, #249); worth a GC trace |
| 13 | `http.ts:119` | An unknown GET path is 405, not 404 | cosmetic | not changed |

Checked and sound: the turn gate's load fails open (`loadTurnGate` returns null on any read or parse failure, the
header is validated against every array the forward reads, `read` is wrapped in the partner, and a gate-only start
needs `pushOpen` with candidates); its scratch buffers are per process but `read` is synchronous, so no state crosses
users. The card re-ask runs at most once a batch, only for a readable, uncut reply with no requests, under its own
`Budget` reservation (over budget: skipped), through the same redacting prompt builder (`cardMessages`); no wrapper
outside the lab drops `CardMakeOptions`. `pushStart`'s new regexes read a 400-character head. Metrics labels carry no
tenant, user or text; blob names join tenant and user with NUL (refused by `isId`) under a keyed hash; `/internal/*`
and `/metrics` are kept off the internet by Caddy.

## Hot path and memory (no model)

`pipeline.bench.ts` (1,500 items a source, 2,000 events), three alternating runs per arm; "nogate" is main with
`pushGate: false`.

| | base 5026ba512 | main 3b54c433 | main, gate off |
|---|---|---|---|
| observe p50, all events (µs) | 131.0, 113.1, 109.1 / 115.7, 101.8, 113.9 | 132.4, 116.7, 122.4 / 122.9, 119.5, 124.4 | 117.9, 114.8, 115.0 / 116.6, 109.8, 110.6 |
| observe p99, all events (µs) | 5,874, 4,421, 4,192 / 4,749, 3,961, 4,229 | 4,638, 4,030, 4,369 / 4,548, 4,043, 4,260 | 4,365, 3,811, 4,112 / 4,003, 4,588, 4,067 |
| observe p50, user messages only (µs) | 1,904, 1,762, 1,848 | 1,929, 1,775, 1,843 | 1,910, 1,833, 1,809 |
| observe p99, user messages (µs) | 5,933, 5,035, 5,145 | 5,581, 5,321, 4,951 | 5,528, 6,030, 5,473 |

The gate alone (`TurnGate.read`, scratch bench): 25 µs for "hello", 58 µs for a 64-character request, 102 µs at the
300-code-point cap, 203 µs for a 2,130-character French message. It adds about 5–10% to the all-event p50 (well
under the 20% bar) and nothing measurable to a user message's observe, so no fix was needed.

Memory: `users.bench.ts 300 500`: live 0.93 MB heap a user on both trees (RSS 1.57 vs 1.58 MB). Frozen 0.17 →
0.43 MB heap a user, thaw p50 29 → 3 ms: the warm tier (D862), as designed. Server (`perf-cli.ts memory --steps
250,500`, sim worlds subtracted): heap 0.527 vs 0.519 MB a user; RSS 0.865 vs 1.018 MB a user over the whole
reading, but 0.69 vs 0.72 MB a user between 250 and 500 users (the zero-user baselines differ by 49 MB). The gate's
weights are 1.59 MB once a process.

## Deploy smoke (main 3b54c433)

The quickstart's settings (`EDEN_PROCESSES=2`, a 64-hex `EDEN_PERSIST_KEY`, grace 15 s, drain delay 5 s, no model
key, a static three-document sources file): `/healthz`, `/readyz`, `/metrics` 200; 23 malformed requests gave
400/401/403/404/405/413, no 5xx; two users through the client SDK got injections and asks citing their items; SIGTERM
wrote each child's live users (2 blobs, mode 600), a restart with the same key read them back (same citations),
`/readyz` was 503 from 1 ms after SIGTERM and the process exited 0 after 5.08–5.10 s (an in-flight slow upload
finished 200); a wrong key and corrupt files started ready and served 200s. `docker build` of the image: 
`turn-gate.bin` is in it (1,591,772 bytes, sha256 matching the repo), `turnGate()` loads there, `docker stop` 5.2 s,
exit 0. The .dockerignore excludes only `*.db`, root `bench`/`docs`/`native` and env files.

## Gates on the branch

RESULTS
