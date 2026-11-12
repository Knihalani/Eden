"""F7: the rule sheet's prompt-cache hit rate and its price a check (D1180), from a user's request spacing [EST].

    python3 -I packages/sim/lab/f7/sheet-cache.py [--sheet-chars 8000,10000] [--per-day 16] [--changes 1,4]

The push check sends the user's rule sheet as its own cached block after the fixed instructions (push-check.ts
`checkMessages`). A check reads it from the provider's cache when the same sheet was sent within the TTL; otherwise
it writes it (Anthropic: 1.25x input on the 5-minute TTL, 2x on the 1-hour one; a read is 0.1x). The sheet's text
changes when a new active card arrives (newest first), so a change also forces a write.

Spacing models for a heavy user (about 480 requests a month, `--per-day` on each of 30 days):
- `lab`: pi-ab `--days`'s clock, a fixed `--gap-min` 10 minutes between requests, a night between days;
- `poisson`: the day's requests at random over its active hours (F3's 220 active hours a month, about 7.3 a day);
- `bursty`: sessions of 2-5 requests a minute or two apart, sessions at random over the active hours.
Sheet changes (`--changes LO,HI` a day) land at random times in the day. Monte Carlo, 2,000 user-days a cell.
Prices: Haiku 5.5 list, $0.10 a million input tokens, four characters a token.
"""

import argparse
import random

IN = 0.10e-6
RATE = {"read": 0.1, "5m": 1.25, "1h": 2.0}
TTL_MIN = {"5m": 5, "1h": 60}
ACTIVE_MIN = 220 * 60 / 30


def day_times(model, n, rng, gap):
    if model == "lab":
        return [i * gap for i in range(n)]
    if model == "poisson":
        return sorted(rng.uniform(0, ACTIVE_MIN) for _ in range(n))
    out = []
    while len(out) < n:
        start = rng.uniform(0, ACTIVE_MIN)
        t = start
        for _ in range(min(rng.randint(2, 5), n - len(out))):
            out.append(t)
            t += rng.uniform(0.5, 2.0)
    return sorted(out)


def hit_rate(model, ttl, n, changes, rng, gap, days=2000):
    hits = total = 0
    for _ in range(days):
        times = day_times(model, n, rng, gap)
        span = max(times[-1], 1.0)
        cuts = sorted(rng.uniform(0, span) for _ in range(rng.randint(*changes)))
        last = None
        for t in times:
            changed = last is not None and any(last < c <= t for c in cuts)
            if last is not None and not changed and t - last <= TTL_MIN[ttl]:
                hits += 1
            total += 1
            # A write or a read refreshes the entry's TTL.
            last = t
    return hits / total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet-chars", default="8000,10000")
    ap.add_argument("--per-day", type=int, default=16)
    ap.add_argument("--changes", default="1,4")
    ap.add_argument("--gap-min", type=float, default=10.0)
    ap.add_argument("--checks-per-task", type=float, default=0.93)
    ap.add_argument("--pointer-saving", type=float, default=0.000019, help="D1180's pool pointers, $ a check")
    a = ap.parse_args()
    rng = random.Random(1180)
    changes = tuple(int(x) for x in a.changes.split(","))
    sizes = [int(x) for x in a.sheet_chars.split(",")]
    print(f"per day {a.per_day}, sheet changes {changes[0]}-{changes[1]} a day, sheet {sizes} chars [EST]")
    print("$ a check for the sheet, net of the pointers' saving; per 1,000 tasks at "
          f"{a.checks_per_task} checks a task")
    for s in sizes:
        tok = s / 4
        unc = tok * IN - a.pointer_saving
        read = tok * IN * RATE["read"] - a.pointer_saving
        per_1k = unc * a.checks_per_task * 1000
        print(f"\nsheet {s} chars ({tok:.0f} tokens): uncached ${unc:+.6f} (${per_1k:+.3f}/1k), "
              f"all reads ${read:+.6f}, 5m write ${tok * IN * 1.25 - a.pointer_saving:+.6f}, "
              f"1h write ${tok * IN * 2 - a.pointer_saving:+.6f}")
        for model in ("lab", "poisson", "bursty"):
            for ttl in ("5m", "1h"):
                h = hit_rate(model, ttl, a.per_day, changes, rng, a.gap_min)
                per = tok * IN * (h * RATE["read"] + (1 - h) * RATE[ttl]) - a.pointer_saving
                print(f"  {model:8s} {ttl}: hit {h:.2f}  ${per:+.6f} a check  ${per * a.checks_per_task * 1000:+.3f}/1k"
                      f"  ({'cheaper' if per < unc else 'dearer'} than uncached)")
    print("\nbreak-even hit rate against uncached: 5m 0.22, 1h 0.53")


if __name__ == "__main__":
    main()
