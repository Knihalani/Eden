"""M1 micro track, gate G0 ($0): does a scorer agree with Haiku's push check as closely as Haiku agrees with itself?

Reads M7's recorded check calls (`--check-dump` rows, Volume `eden-m7`), the scorer's per-item scores for the same
pools in the same order (`m1_serve.py score_pools` over the rows in sorted file order), and M7's re-asks
(`agree*.jsonl`: Haiku's verdict again on a fixed shuffle of the train 41-44 rows, `self-agree.ts`).

The scorer's verdict on a call is the items scoring at or above a mark, chosen on the train1-4 suites' calls to
maximise exact-set agreement with Haiku's recorded verdict, then read on train5-6 (M7's held-out families).

  python3 -I packages/sim/lab/m1-student/g0.py --dumps .local/m1/m7 --scores S.jsonl
"""
import argparse
import glob
import json
import os


def lcg_sample(rows):
    """self-agree.ts's fixed shuffle of the rows whose verdict was readable."""
    pick = [r for r in rows if r["yes"] is not None]
    s = 7
    for i in range(len(pick) - 1, 0, -1):
        s = (s * 1103515245 + 12345) % 2147483648
        j = s % (i + 1)
        pick[i], pick[j] = pick[j], pick[i]
    return pick


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dumps", required=True)
    ap.add_argument("--scores", required=True)
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(a.dumps, "train-4*.jsonl")))
    rows = [json.loads(l) for f in files for l in open(f) if l.strip()]
    scores = [json.loads(l) for l in open(a.scores)]
    assert len(rows) == len(scores), (len(rows), len(scores))
    for r, s in zip(rows, scores):
        r["s"] = s
    # Haiku against itself (M7's samples on train 41-44).
    base = [r for r in rows if r["seed"] in (41, 42, 43, 44)]
    sample = lcg_sample(base)
    for name in ("agree", "agree-2", "agree-3"):
        p = os.path.join(a.dumps, f"{name}.jsonl")
        if not os.path.exists(p):
            continue
        ag = [json.loads(l) for l in open(p)]
        same = sum(set(x["recorded"]) == set(x["again"]) for x in ag)
        sil = [x for x in ag if not x["recorded"]]
        speak = sum((not x["recorded"]) == (not x["again"]) for x in ag)
        print(f"Haiku vs itself ({name}): exact set {same}/{len(ag)} {same / len(ag):.3f}; speak/silent "
              f"{speak / len(ag):.3f}; silence kept {sum(not x['again'] for x in sil)}/{len(sil)}")

    def agree(rs, m):
        ex = sp = 0
        for r in rs:
            ids = [it["id"] for it in r["items"]]
            mine = {i for i, v in zip(ids, r["s"]) if v >= m}
            hy = set(r["yes"])
            ex += mine == hy
            sp += (not mine) == (not hy)
        return ex / len(rs), sp / len(rs)

    ok = [r for r in rows if r["yes"] is not None]
    fit = [r for r in ok if r["suite"] in ("train1", "train2", "train3", "train4")]
    held = [r for r in ok if r["suite"] in ("train5", "train6")]
    marks = [x / 4 for x in range(-48, 17)]
    best = max(marks, key=lambda m: agree(fit, m)[0])
    print(f"scorer mark chosen on train1-4 ({len(fit)} calls): {best} (exact {agree(fit, best)[0]:.3f})")
    ex, sp = agree(held, best)
    print(f"scorer vs Haiku on train5-6 (held-out families, {len(held)} calls): exact set {ex:.3f}; speak/silent {sp:.3f}")
    # The same with the recorded sample's own pools for a like-for-like line (train 41-44, all suites).
    exs, sps = agree([r for r in sample[:296]], best)
    print(f"scorer vs Haiku on M7's 296 self-agreement pools: exact set {exs:.3f}; speak/silent {sps:.3f}")


if __name__ == "__main__":
    main()
