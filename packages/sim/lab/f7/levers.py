"""F7: what each cost and latency lever saves, priced from what the lab recorded ($0, every figure [EST]).

    python3 -I levers.py LEDGER DUMP.jsonl [DUMP.jsonl ...]

Inputs: the push check's ledger rows (tokens a call) and the `--check-dump` rows of the same runs (pools, replies,
verdicts, task variants). Prices: Haiku 5.5 list, $0.10 input, $0.01 cache read, $0.125 cache write (5 min), $0.50
output per million. Wait: H3's fit, 596 ms + 2.93 ms an output token. Per 1,000 tasks on the 1:1:8 mix (0.1 hidden,
0.1 control, 0.8 neutral), each kind's calls a task from the dumps over 192 tasks a kind a suite and seed.
"""
import json
import re
import sys
from collections import Counter, defaultdict

P_IN, P_CR, P_OUT = 0.10e-6, 0.01e-6, 0.50e-6
W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
TASKS_A_KIND = 192  # train1–6 (or reworded) × one seed: 32 templates × 6 suites


def wait(out):
    return 596 + 2.93 * out


def main():
    ledger, dumps = sys.argv[1], sys.argv[2:]
    calls = [json.loads(l) for l in open(ledger)]
    calls = [c for c in calls if c.get("role") == "eden.check" and c.get("run", "").startswith("f7-base")]
    n = len(calls)
    inp = sum(c["usage"]["inputTokens"] for c in calls) / n
    cr = sum(c["usage"]["cachedInputTokens"] for c in calls) / n
    out = sum(c["usage"]["outputTokens"] for c in calls) / n
    hit = sum(1 for c in calls if c["usage"]["cachedInputTokens"] > 0) / n
    usd = (inp - cr) * P_IN + cr * P_CR + out * P_OUT
    print(
        f"check a call: {inp:.0f} in ({cr:.0f} cached, hit rate {hit:.0%}), {out:.0f} out; ${usd:.6f}; "
        f"wait {wait(out):.0f} ms"
    )
    rows = [json.loads(l) for f in dumps for l in open(f)]
    seeds = len(dumps)
    per_kind = Counter(r["variant"] for r in rows)
    rate = {k: per_kind[k] / (TASKS_A_KIND * seeds) for k in W}
    mix_rate = sum(W[k] * rate[k] for k in W)
    print("calls a task by kind:", {k: round(v, 3) for k, v in rate.items()}, f"mix {mix_rate:.3f}")
    base_1k = 1000 * mix_rate * usd
    base_wait = mix_rate * wait(out)
    print(f"check per 1,000 tasks on the mix: ${base_1k:.4f}; mean wait a task {base_wait:.0f} ms")

    # 1. pushCheckLeanStop, as simulated on the recorded replies (shipped order cut at the first no).
    kept = defaultdict(lambda: [0, 0])
    lost_planted = 0
    named_planted = 0
    for r in rows:
        if r.get("yes") is None or not r.get("reply"):
            continue
        m = re.search(r'"act"\s*:\s*false', r["reply"])
        k = kept[r["variant"]]
        k[0] += len(r["reply"])
        k[1] += m.start() if m else len(r["reply"])
        if r["variant"] == "hidden" and r["planted"] in r["yes"]:
            named_planted += 1
            idx = [it["id"] for it in r["items"]].index(r["planted"]) + 1
            head = r["reply"][: m.start()] if m else r["reply"]
            found = re.search(r'"i"\s*:\s*"?%d"?[^{}]*"act"\s*:\s*true' % idx, head)
            lost_planted += not found
    share = {v: k[1] / k[0] for v, k in kept.items()}
    mix_share = sum(W[v] * rate[v] * share.get(v, 1) for v in W) / mix_rate
    d_out = out * (1 - mix_share)
    print(
        f"1 lean stop: output kept {mix_share:.0%} on the mix "
        f"(by kind {', '.join(f'{v} {s:.0%}' for v, s in share.items())}); "
        f"-{d_out:.0f} tokens a call, -{2.93 * d_out:.0f} ms a call, -{mix_rate * 2.93 * d_out:.0f} ms a task, "
        f"-${1000 * mix_rate * d_out * P_OUT:.4f} per 1,000 tasks ({d_out * P_OUT / usd:.0%} of the check); "
        f"planted named after the first no: {lost_planted}/{named_planted}"
    )

    # 2. Prompt caching: the instructions are the only stable prefix; the misses pay them in full.
    miss_cost = (1 - hit) * cr / max(hit, 1e-9) * (P_IN - P_CR)
    print(
        f"2 caching: {1 - hit:.0%} of calls miss the cached instructions; all hits would save "
        f"${1000 * mix_rate * miss_cost:.4f} per 1,000 tasks and no wait (latency is not input-bound, D241)"
    )

    # 3. Skipping the check: the ceiling is an oracle that skips exactly the calls whose answer is silence.
    silent = Counter(r["variant"] for r in rows if r.get("yes") == [])
    sil_rate = {k: silent[k] / (TASKS_A_KIND * seeds) for k in W}
    mix_sil = sum(W[k] * sil_rate[k] for k in W)
    print(
        f"3 skip ceiling (an oracle skipping only the silent checks): {mix_sil / mix_rate:.0%} of calls; "
        f"-${1000 * mix_sil * usd:.4f} per 1,000 tasks, -{mix_sil * wait(out * 0.3):.0f} ms a task "
        f"(a silent reply is short: 30% of the mean output assumed) [the turn gate does not see the pool]"
    )


main()
