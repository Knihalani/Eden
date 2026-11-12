# F9: the subagent transport (queue) and how far it agrees with the real API

D1101. Lab only. Packages: `packages/sim/src/lab/queue-transport.ts`, `packages/sim/lab/subagent/` (batcher, driver
procedure), `pi-ab --agent-sim single`.

## Why

The Anthropic account behind `HAIKU_API_KEY` has no credit and will not get any; OpenRouter is forbidden for the lab
(D818). Seven sessions (F1–F3, F5–F8) were blocked on paid lab runs. The owner's instruction: use haiku subagents to
simulate. The queue transport lets every existing lab harness run unchanged, with each model call answered by a Claude
Code subagent through files.

## What it is

See packages/sim/lab/subagent/README.md for the commands. In short: `EDEN_LAB_QUEUE=DIR` replaces the global `fetch`
for Anthropic's Messages API in every lab process; a call is keyed by role, model and normalised body; a hit in
`DIR/done/` answers at once, a miss is written to `DIR/pending/` and waited for; `batch.ts take|prompt|put` hands
batches to haiku subagents and validates their answers. Zero usage is reported, so the spend ledger books $0, and
every call is logged with `transport: subagent-sim`.

## First runs (train1, seed 41)

- `bun run funnel --suite train1 --seeds 41 -- --check live --check-cache …` with `EDEN_LAB_QUEUE` set: 64 push-check
  calls, answered by 7 haiku subagents in batches of 8–10 (47–83 s a batch, about 75,000 characters each), 64 of 64
  valid on the first `put`, `CHECK … 64 calls of 64 asked, 0 failed`, $0. TOTAL hidden 24/32, decoys 26/32; the run
  took 263 s, most of it waiting for subagents.
- `pi-ab --agent-sim single` on train1 seed 41 (hidden and control, tools and eden): see below.

## Fidelity against recorded API replies

Pending (second message to the integrator).
