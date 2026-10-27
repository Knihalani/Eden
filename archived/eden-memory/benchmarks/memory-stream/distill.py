"""C7-E2: train the distilled row scorer (methods_distill.py) on the calibrated verifier's scores.

    python3 benchmarks/memory-stream/distill.py train --worlds code+life     → distill/weights-code+life.json

Per training world, every event in `verify/<world>-cal*/out` (first directory in sorted order wins) gives one example
per shortlisted candidate the verifier scored; the target is its calibrated p. Soft-label logistic regression, L2,
standardized features. The threshold is set so the scorer fires on the same share of the training human turns as
the verifier at p ≥ 0.6.
"""
import argparse, glob, json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def labels(world):
    out = {}
    for d in sorted(glob.glob(os.path.join(HERE, "verify", f"{world}-cal*"))):  # never verify/<world>-rt*
        for p in sorted(glob.glob(os.path.join(d, "out", "*.json"))):
            for c in json.load(open(p))["cases"]:
                if "scores" in c and c["event"] not in out:
                    out[c["event"]] = c["scores"]
    return out


def examples(world):
    import score, sleep, methods
    stream, items = score.load_stream(world)
    cov = score.Coverage(items)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    m = methods.make("distill:k=15", sleep.rows(stream, world, strict=True), stream, items, cov)
    X, y, groups, human, seen = [], [], [], [], [0, 0]
    for eid, sc in sorted(labels(world).items(), key=lambda kv: evs[kv[0]]["_order"]):
        e = evs[eid]
        cand, feats = m.candidates(e, e["_order"])
        seen[0] += len(sc)
        seen[1] += sum(i in sc for i in cand)
        for i, x in zip(cand, feats):
            if i in sc:
                X.append(x)
                y.append(float(sc[i]))
                groups.append(eid)
        human.append((eid, e["t"] == "human", max(sc.values(), default=0.0)))
    print(world, len(human), "events,", len(X), "examples; shortlist match", f"{seen[1]}/{seen[0]}")
    return X, y, groups, human


def fit(X, y, l2=1e-3, steps=3000, lr=0.5):
    X, y = np.array(X), np.array(y)
    mean, sd = X.mean(0), X.std(0)
    sd[sd < 1e-6] = 1.0  # a feature constant in training (e.g. trigger) stays 0 after standardizing
    Z = (X - mean) / sd
    w, b = np.zeros(Z.shape[1]), 0.0
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = p - y
        w -= lr * (Z.T @ g / len(y) + l2 * w)
        b -= lr * g.mean()
    return {"mean": mean.tolist(), "sd": sd.tolist(), "w": w.tolist(), "b": float(b)}


def train(worlds):
    import methods_distill as D
    X, y, groups, human = [], [], [], []
    for w in worlds.split("+"):
        a, b, c, d = examples(w)
        X += a
        y += b
        groups += c
        human += d
    model = fit(X, y)
    p = 1 / (1 + np.exp(-(((np.array(X) - model["mean"]) / model["sd"]) @ np.array(model["w"]) + model["b"])))
    best = {}
    for g, v in zip(groups, p):
        best[g] = max(best.get(g, 0.0), float(v))
    hum = [(eid, top) for eid, is_h, top in human if is_h]
    share = sum(top >= 0.6 for _, top in hum) / len(hum)
    preds = sorted((best.get(eid, 0.0) for eid, _ in hum), reverse=True)
    n_fire = round(share * len(preds))
    model["thr"] = preds[n_fire - 1] if n_fire else 1.0
    model["features"] = D.FEATURES
    model["train"] = {"worlds": worlds, "examples": len(X), "human_turns": len(hum), "verifier_fire_share": share}
    corr = float(np.corrcoef(p, y)[0, 1])
    print("verifier fire share", round(share, 4), "threshold", round(model["thr"], 4), "train corr(p, target)",
          round(corr, 4))
    for f, wt in sorted(zip(D.FEATURES, model["w"]), key=lambda t: -abs(t[1]))[:8]:
        print(f"  {f:12s} {wt:+.3f}")
    os.makedirs(os.path.join(HERE, "distill"), exist_ok=True)
    json.dump(model, open(D.weights_path(worlds), "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["train"])
    ap.add_argument("--worlds", required=True, help="training worlds joined by +, e.g. code+life")
    a = ap.parse_args()
    train(a.worlds)
