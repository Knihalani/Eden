"""M8: the parity fixture for the TypeScript router (`m8-parity.test.ts`): 64 held-out requests from route logs, each
with up to 16 of its sources (their keys and inputs), and the probabilities and gate decisions Python computes with
the int8 table exactly as the engine does (each row one source).

  python3 -I parity.py MODEL.npz "LOGS/*.jsonl" OUT.json
"""
import json
import sys

import numpy as np

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import train_router as T  # noqa: E402


def main():
    model, logs, out = sys.argv[1:4]
    net, W = T.load(model)
    q, sc = T.quantise(W)
    Wq = q.astype(np.float64) * sc
    cases = []
    for keys, d in T.read_logs(logs):
        if len(cases) >= 64:
            break
        rows = d["rows"][:16]
        f = np.asarray(d["features"], dtype=np.uint64)
        k = [keys.get(r["id"], np.zeros(0, np.uint64)) for r in rows]
        X = np.asarray([r["x"] for r in rows], dtype=np.float64)
        X[:, 0] = T.conj_scores(Wq, f, k)
        summ = np.asarray(
            [X[:, 0].max(), X[:, 1].max(), float(X[:, 3].max() > 0), float(X[:, 4].max() > 0), np.log1p((len(f) + 1) / 2)]
        )
        e = {"X": X, "lw": np.zeros(len(rows)), "s": summ, "w": np.ones(len(rows))}
        p, p0 = net.probs(e)
        cases.append(
            {
                "features": [int(x) for x in f],
                "keys": [[int(x) for x in kk] for kk in k],
                "x": [[float(v) for v in r["x"][1:]] for r in rows],
                "terms": int(len(f)),
                "p": [float(v) for v in p],
                "pNull": float(p0),
                "gate": [bool(v >= net.floor) for v in p],
            }
        )
    json.dump({"floor": net.floor, "cases": cases}, open(out, "w"))
    print(f"parity: {len(cases)} cases -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
