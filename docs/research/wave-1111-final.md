# The 11 November wave: what shipped, what it bought, what is left

Status: 2026-11-12. This covers `main` from 5026ba512 (11 Nov, 13:57 UTC, before the wave) to the final commit
93b1a1f3, which B19 benchmarked. It also covers the docs, lab and deploy merges after it (#276 onwards).

Every number here comes from a merged note and the command named there. **Lab-provider** means Anthropic's API through
the lab transport (D97), not the shipped OpenRouter route. **[EST]** marks an estimate.

## In plain words

- **Quality went up on a blind suite.** In B19, heldout19 was read once, with Sonnet grading and a Haiku 5.5 agent.
  Over the before-wave Eden, the final Eden raises 16–18 points more of the facts the agent needed but did not ask
  for:
  - Hermes: 30.0% → 46.2%, +16.3 points (+5.0..+28.1).
  - Pi: 30.0% → 47.5%, +17.5 (+6.3..+29.4).
- **Against the agent alone,** Eden raises about 32–33 points more (Hermes 13.1% → 46.2%). Confirmed false concerns
  are 0 in every arm.
- **Eden stays quieter.** On neutral turns it hands a packet on 64 of 160 instead of 92 (−17.5 points, −32.5..−1.9),
  with about half the items.
- **The price is the push check, a Haiku call.**
  - Eden's own model spend goes from $0.07 to $0.24 per 1,000 tasks (lab-provider). The push check is $0.16 of that.
  - Each task takes about 0.6 s longer than before on Hermes (+0.18..+0.99) and 0.9 s longer on Pi. Against the agent
    alone, Hermes is level (+0.09 s) and Pi is +0.39 s.
  - The agent's own spend is level.
- **Without a model key, nothing changed.** The no-model eval reads precision 0.65, recall 0.52 and false fires 0 at
  both ends. The funnel at full coverage reads 315/276 at both ends.
- **Haiku is not gone.** Two roles keep it: the push check and the background card/intent call. Every micro model
  built to replace a Haiku role was measured against a pre-registered bar and stopped (below). The one model that
  beats Haiku on the push check is an 8B model that needs a GPU, which is your decision.
- **Deploy is ready.** Persistence is on by default and a wrong key now refuses to start. Scaling covers one box to
  many. The kit (compose, Caddy, OpenTofu, cloud-init, monitoring, sizing) has been smoke-tested end to end, including
  a real `docker build`. Our hosting cost is $0.073 per heavy user-month at 1,000 users, $0.021 at 10,000 and $0.0125
  at 100,000 (no model key).

## B19: raw agent vs Eden before vs Eden final

Source: [b19-final.md](b19-final.md), D1048. The run: heldout19, seeds 41–44, 40 templates, read once. 27 processes,
0 ungraded. The agent is Haiku 5.5 and the grader Sonnet 5.5, all lab-provider; every Eden role is Haiku 5.5. CIs are
paired bootstraps with 5,000 draws, clustered by template (short) or by user-day (days).

Hidden facts raised, the pre-registered headline:

| harness, shape | raw | before | final | final − before | final − raw |
| --- | ---: | ---: | ---: | --- | --- |
| Hermes, short | 13.1% | 30.0% | 46.2% | +16.3 (+5.0..+28.1) | +33.1 (+21.9..+45.0) |
| Pi, short | 15.6% | 30.0% | 47.5% | +17.5 (+6.3..+29.4) | +31.9 (+20.0..+44.4) |
| Hermes, days | 1/16 | 7/16 | 8/16 | +6.3 (−12.5..+25.0), direction only | +43.8 (+18.8..+68.8) |
| Pi, days | 1/16 | 6/16 | 9/16 | +18.8, direction only (8 clusters) | +50.0 (+25.0..+75.0) |

Cost, time and silence (Hermes short; Pi short where it differs):

| | raw | before | final |
| --- | ---: | ---: | ---: |
| Eden's model spend, $ per 1k tasks | 0 | 0.07 (Pi 0.08) | 0.24 (Pi 0.25) |
| Agent's spend, $ per 1k tasks | 0.41 | 0.43 | 0.42 (Pi 0.26 in all three) |
| Wall time a task, p50 | 4.8 s | 4.5 s | 5.1 s |
| Neutral turns with a packet | — | 92/160 | 64/160 |
| `ask_context` calls a task | 0 | 0.123 | 0.119 |
| Connector calls a task vs raw | — | −0.70 (−1.10..−0.34) | level with before |
| Confirmed false concerns | 0 | 0 | 0 |

Sonnet flagged 2 of 2,784 control and neutral answers, both in Pi short's final arm. Read by hand, one is a
conditional hedge and one a grader error; neither is confirmed.

## What shipped into the default

| PR | change | evidence |
| --- | --- | --- |
| #254 | Push check S and indirect requests in the default (D820–D829) | the push-check family decided on Pi |
| #267 | `pushGate`: a 1.59 MB multilingual turn gate beside the start rule (D1010–D1015) | your decision (D1014); it failed language-parity, strict-English and fixture clauses; the facts guard and Pi held |
| #268 | `cardsRequestsFix`: the card prompt no longer drops requests lists (D1060–D1063) | Pi +4.1 points (+0.5..+7.7), concerns 1 vs 1 of 1,216; funnel decoys +11 of 608, accepted explicitly (D1061) |
| #272 | Live-user memory −13% to −20% (D998) | users.bench; observe p99 +5.7% |
| #249 | Idle compaction and a warm two-tier freeze: 1.1–1.6× users per box (D860–D864) | users.bench |

The default runs 74 switches against the core (`default.test.ts`). The funnel baseline at shipped coverage is
295/384 hidden, 268/384 decoys (281/264 before #268).

## Deploy readiness

- **Image and persistence** (#263, D990–D995):
  - the Dockerfile is fixed;
  - persistence is on by default, encrypted with `EDEN_PERSIST_KEY`;
  - bucket placement and a shared frozen disk on S3;
  - a cluster router, `/readyz`, `/metrics` and drain;
  - the `deploy/` kit: compose, Caddy, OpenTofu for Hetzner and OCI, cloud-init, a dedicated-box bootstrap, Alloy
    monitoring, and `sizing.py`.
- **Quick start and checks** (#265): `docs/DEPLOY-QUICKSTART.md`, plus static checks for the Terraform and the
  monitoring config.
- **Release audit** (#271, #273; R1, D1070, D1071). It audited #251–#270 and fixed nine issues in the deploy layer:
  - a forgotten user could be restored by a fenced old owner's late write (privacy);
  - one crashed child failed a single box's `/readyz`;
  - unbounded growth in the shared disk's absent set;
  - a cluster router with no timeout on a hung node;
  - stray 500s;
  - and others.

  A wrong `EDEN_PERSIST_KEY` now refuses to start (exit 2) instead of silently discarding every user.
  `EDEN_PERSIST_DISCARD=1` overrides that, and a `key-id` marker tells a documented key rotation apart from a typo.
  Deploy smoke: the probes answer; 23 bad requests got only 4xx; the SDK works; SIGTERM drains; a restart restores
  state; `docker build` puts `turn-gate.bin` in the image and the gate loads there.
- **Latency on the fast path** (pipeline.bench, 2,000 events): the gate adds about 5–10% to the all-event observe
  p50, 117–132 µs against 102–131 before the wave. The p99 is unchanged within noise.
- **Capacity** (`sizing.py`, at 4.71 MB a heavy user at peak): 1,845 heavy users on a 2-core 12 GB box, 3,702 on
  4/24, 9,964 on 64 GB, 19,939 on 128 GB. R1's capacity soak checks these against a live server under load; see the
  addendum.
- **Our cost per heavy user-month** (no model key; Hetzner dedicated; COST-MODEL.md, prices read 2026-11-11, check at
  signup): $0.073 at 1,000 users, $0.021 at 10,000, $0.0125 at 100,000. Oracle Always Free covers about 1,800 heavy
  users at $0, with reclamation risk.
- **With a model key**, Eden's Haiku calls are about $0.36–0.41 per heavy user-month [EST], 5 to 30 times the hosting.
  The tenant pays that, or runs without a key on the no-model default. The tenant's connector and agent costs are
  estimated in COST-MODEL.md §Hosting (b).

## The Haiku that remains, and why

| role | Haiku cost | the replacement tried | why it stopped |
| --- | --- | --- | --- |
| Push check S (request path) | $0.16 per 1k tasks (B19) | M1: a micro CPU checker distilled from an 8B (D982); M7: a pre-screen (D930) | the micro reached fact-vs-look-alike AUC 0.656 on the sim's dev templates (the 8B 0.913) and named 51 of 144 dev facts where Haiku names 116 |
| Push check S, cheaper | | H3: drop repeats, read at most 10 items (D1072–D1074) | check cost −25%, but facts missed the −1.5-point bound twice: −0.4 (−2.3..+1.5), then −0.163 (−1.533..+1.271) |
| Cards (background) | $0.08 per 1k tasks (B19) | M10: a micro card tagger (D960) | missed the held-out bar (−1.4%) |
| Intent (background) | in the card call | M11: micro intent expansion (D970) | bridge terms are world knowledge a CPU model does not hold |
| Pool ranking (no Haiku today) | — | M12: a teacher-distilled scorer (D1000–D1004) | its edge was item length; with length hidden, +2 points against a +6 bar |
| Source router (no Haiku) | — | M8 (D940–D949) | Pi −0.7 points (−2.0..+0.6) against a −1.5 bound |
| Supersession, packet trimming | — | M3b (D914), M6 (D920) | failed hand-written and held-out rules |

M14 (D1020–D1025) found the common cause. The synthetic training data (M2) teaches item length: length alone puts the
fact first in 94.3% of M2's test tasks. No training recipe beat plain M2 on the held-out sim. Its kit (`logo.py`, the
length-debiased M2) is now the screen for any future micro model.

## Decisions for you

1. **An 8B push check on a GPU.** It is the only model past Haiku on the sim (AUC 0.913 on dev; 0.950 on M2 families
   it never saw). Kept warm on an H100 it is about $95 a day [EST, m1-student.md]. Haiku's check is about $0.16–0.20
   per 1,000 tasks, so the GPU pays only past roughly 500,000 checked requests a day [EST]. Recommendation: stay on
   Haiku until volume justifies it.
2. **H3's cheaper push check** (code at 7e528b60). It cuts the check's cost about 25%, about 10% of Eden's model
   spend, with concerns level. It missed the strict bar by 0.03 points; pooled over both runs it would pass,
   −0.239 (−1.346..+0.848) over 4,602 pairs. The rule kept the runs apart, so it is deleted. Recommendation: leave it
   out unless cost matters more than a possible fraction of a point; promoting it needs a new decision.
3. **Modal volumes.** `eden-embed-cache` and `eden-cards-distill` are unused and still need deleting in the Modal
   dashboard. Modal spend for the month: $125.00 of the $1,000 cap (M1's guard, 00:13 UTC).
4. **The wrong-key refusal** (D1071) was decided overnight: refuse with an explicit override. Revert it if you would
   rather a wrong key start empty.

## Spend over the wave

Modal: $125.00 of $1,000 (M1's guard, 00:13 UTC on 12 Nov). Anthropic, lab-provider, by session from their reports:

| session | spend |
| --- | ---: |
| H3 | $21.64 |
| M14 | $20.31 |
| B19 | $9.96 |
| M8 | about $5.9 |
| H2b | $3.36 |
| R1, D1 | $0 |

No OpenRouter calls. heldout19 was read once, by B19.

## Addendum: R1's capacity soak (#278, D1075)

Source: [r1-release.md](r1-release.md) §Round 3. The harness, `packages/sim/src/lab/soak.ts`, sends heavy users
(3,000 items over 20 connectors) through the real handler. Setup:

- the encrypted disk, one process per core;
- a 2-core 12 GiB cgroup;
- no model key;
- sessions arrive at exponential intervals with a 12-minute mean.

- **1,500 heavy users for 30 minutes, with a restart at 15:**
  - 33,382 requests and 0 errors.
  - Latency at load:

    | | p50 | p99 |
    | --- | --- | --- |
    | event | 0.46 ms | 96 ms |
    | user message | 4.9 ms | 15 ms |
    | ask | 9.5 ms | 272 ms |

    The ask p99 was 21 ms before the restart.
- **Sizing holds.** RSS works out to 4.51 MB a heavy user, against sizing.py's 4.71: 1,927 users on the 2/12 box
  against the 1,845 claimed (+4%), or 1,612 on the p95 GC sawtooth (−13%). Both are within 15%, so the table stands.
  GC peaks sit about 22% above the settled figure; DEPLOY.md says so.
- **No leak.** 1,000 users ran for 40 minutes with forced GCs: the heap slope was about −3 MB/min a process, with
  25,035 requests and 0 errors.
- **The restart finding.** Within its shutdown budget (0.3 × the 15 s grace, oldest users first), a full box writes
  about 23% of its users. The rest re-sync from their sources: about 13 minutes at the soak's rate, with 0 errors and
  an ask p99 of about 300 ms meanwhile. A follow-up writes the most recently used users first (R1 round 4).
