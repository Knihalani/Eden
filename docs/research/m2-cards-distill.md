# M2: can a small open model write Eden's background cards instead of Haiku?

Status: in progress, 2026-11-10, session M2. Lab study only: nothing here is wired into product code. Every paid
figure is Modal GPU time at Modal's published per-second list prices (checked on modal.com/pricing on 2026-11-10);
Anthropic spend $0. Decisions D445–D449.

## Pre-registered promote bar (written before step 4, the funnel through the endpoint)

Committed before any funnel run through a distilled model. A model passes only if all of these hold:

1. **Parses.** Item parse rate ≥ 0.95 on the 61 held-out rows (719 items), by Eden's own `parseCards`/`parseRequests`.
2. **Constraint flag against Haiku, held-out.** Recall ≥ 0.65 and precision ≥ 0.75: no worse than the cards the
   funnel replays today (`cards-v2.jsonl` + `cards-train.jsonl`, mixed teachers), which agree with Haiku's
   `intent-v2` flag at precision 0.75 (24/32) and recall 0.65 (24/37) on the 83 held-out items they cover.
3. **Funnel, train1–6, seeds 41–42** (`bun run funnel --cards-endpoint URL`): hidden surfaced ≥ 312 (the default's
   314 minus 2) and decoys surfaced ≤ 273 (not up), task-by-task diff with `--baseline` read and reported.
4. **Cost.** GPU dollars per 1,000 items carded (measured GPU-seconds × list price, at the serving shape measured)
   below Haiku's per-item cost from the ledgers quoted in docs/COST-MODEL.md.

Failing (1)–(3) means no decision to build; failing only (4) means "works, not cheaper" and is written so.
