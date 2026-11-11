"""M3b (D907 follow-on): make H10, the supersession pair network, small and fast without losing the float net's
quality. Shared pieces for every variant: the pair sets (binnet.m2_items on M2 v2's raw worlds), the metrics (AUC,
recall at precision 0.95 and 0.90), the teacher's soft scores and codes, and the students.

  python -I h10.py score --model NET.pt --pairs worlds-val.jsonl            # a binnet checkpoint's metrics
  python -I h10.py teach --model NET.pt --pairs worlds-train.jsonl --out T.pt  # teacher logits over every pair

The students (route A, a better binary; route B, a compressed float; a hybrid) live in `train`, one `--variant` each.
"""
import argparse, json, os, random, sys, time

import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import binnet as B  # noqa: E402

torch.set_num_threads(int(os.environ.get("BINNET_THREADS", "4")))


def metrics(p, y):
    """AUC (rank-sum, ties halved) and the best recall at precision >= 0.95 / 0.90 over thresholds, O(n log n)."""
    n1 = sum(y)
    n0 = len(y) - n1
    order = sorted(range(len(p)), key=lambda i: -p[i])
    out = {}
    for prec in (0.95, 0.90):
        tp = fp = 0
        best = 0.0
        i = 0
        while i < len(order):
            j = i
            # Ties move together: a threshold cannot split equal scores.
            while j < len(order) and p[order[j]] == p[order[i]]:
                tp += y[order[j]]
                fp += 1 - y[order[j]]
                j += 1
            if tp and tp / (tp + fp) >= prec:
                best = max(best, tp / max(1, n1))
            i = j
        out[f"recall@p{prec:.2f}"] = round(best, 3)
    # AUC by average ranks.
    asc = sorted(range(len(p)), key=lambda i: p[i])
    ranks = [0.0] * len(p)
    i = 0
    while i < len(asc):
        j = i
        while j < len(asc) and p[asc[j]] == p[asc[i]]:
            j += 1
        for k in range(i, j):
            ranks[asc[k]] = (i + j + 1) / 2
        i = j
    rs = sum(r for r, t in zip(ranks, y) if t)
    out["auc"] = round((rs - n1 * (n1 + 1) / 2) / max(1, n1 * n0), 4)
    out["pairs"] = len(y)
    out["positives"] = n1
    return out


def pairs_of(path, every=1):
    _, P = B.m2_items(path, every)
    return P


def load_teacher(path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    net = B.PairTag(B.Q(ck["float"]), ck["bits"])
    net.load_state_dict(ck["state"])
    net.eval()
    return net, ck


@torch.no_grad()
def score_net(net, P, bs=512):
    return torch.cat([net([x[0] for x in P[a : a + bs]], [x[1] for x in P[a : a + bs]])
                      for a in range(0, len(P), bs)]).tolist()


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["score", "teach"])
    a.add_argument("--model", required=True)
    a.add_argument("--pairs", nargs="+", required=True)
    a.add_argument("--out", default="")
    o = a.parse_args()
    net, ck = load_teacher(o.model)
    t0 = time.time()
    if o.cmd == "score":
        for path in o.pairs:
            P = pairs_of(path)
            p = score_net(net, P)
            print(json.dumps({"model": os.path.basename(o.model), "pairs_file": os.path.basename(path),
                              **metrics(p, [x[2] for x in P]), "s": round(time.time() - t0)}), flush=True)
    else:
        P = [x for path in o.pairs for x in pairs_of(path)]
        p = score_net(net, P)
        torch.save({"pairs": P, "logits": p}, o.out)
        print(json.dumps({"pairs": len(P), **metrics(p, [x[2] for x in P])}))
