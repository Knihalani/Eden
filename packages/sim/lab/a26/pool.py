# A26 (docs/research/a26-reshow.md §0): the pre-registered pooling of D340's hidden difference. A17's per-task records
# are not in the repository, so its clustered interval is combined with the fresh run's by fixed-effect inverse
# variance (SE = 95% width / 3.92), as written before the fresh run.
# usage: python3 -I pool.py FRESH_MEAN FRESH_LO FRESH_HI   (points; A17's +6.8, -0.5..+14.1 is built in)
import sys, math
est = [(6.8, -0.5, 14.1), tuple(float(x) for x in sys.argv[1:4])]
w = [1 / ((hi - lo) / 3.92) ** 2 for _, lo, hi in est]
m = sum(wi * e[0] for wi, e in zip(w, est)) / sum(w)
se = 1 / math.sqrt(sum(w))
print(f"pooled {m:+.1f} ({m - 1.96 * se:+.2f}..{m + 1.96 * se:+.2f}), SE {se:.2f}; weights A17 {w[0] / sum(w):.2f}")
