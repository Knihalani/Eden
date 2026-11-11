"""M3 FrameRank (D906): train and evaluate the no-embedding ranker over frames.py's candidates.

Pair features are integers and flags (lexical scores quantised, date and amount comparators, people, status and
obligation bits, twin contrast against the item's nearest neighbour, supersession in its thread, graph links to the
lexical head, the learned term-pair channel). A LightGBM model (binary objective: an absolute score, so a threshold
can keep the packet silent) over them. Training worlds mirror the days runs: a request's fact and its all-clear twin
are never in the same world (half of a world's tasks keep the fact, half the twin).

  .venv-m3/bin/python packages/sim/lab/m3r/framerank.py train --fold A --out .local/m3/fr/A [--ablate twin,...]
  .venv-m3/bin/python packages/sim/lab/m3r/framerank.py eval --model .local/m3/fr/A --eval EVAL.jsonl.gz --out RUN
"""
import argparse, gzip, json, os, random, sys, time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames as F  # noqa: E402
from qexpand import learn as learn_table  # noqa: E402

D = "/home/user/Eden/.local/m3/d"
FOLDS = {
    "A": {"suites": ["train1", "train2", "train3", "train4"], "synth": "synth-a-worlds.jsonl.gz", "held": ["train5", "train6"]},
    "B": {"suites": ["train3", "train4", "train5", "train6"], "synth": "synth-b-worlds.jsonl.gz", "held": ["train1", "train2"]},
    "C": {"suites": ["train1", "train2", "train5", "train6"], "synth": "synth-c-worlds.jsonl.gz", "held": ["train3", "train4"]},
}
GROUPS = {  # feature groups, for ablations
    "lex": ["bm25", "bm25_rank", "cover", "shared", "title", "qx", "qx_rank"],
    "date": ["q_days", "i_days", "day_exact", "day_gap", "age", "future"],
    "amount": ["q_amt", "i_amt", "amt_eq", "amt_above"],
    "people": ["names"],
    "status": [f"s_{n}" for n, _ in F.STATUS] + [f"o_{n}" for n, _ in F.OBLIG] + ["verb", "q_status", "q_oblig"],
    "twin": ["nbr_overlap", "nbr_xor", "nbr_newer", "nbr_clears", "self_clears"],
    "supersede": ["thread_newer_clear", "thread_newest", "thread_size"],
    "graph": ["head_links", "chan"],
    "kind": ["kind", "auto", "len"],
}
FEATS = [f for g in GROUPS.values() for f in g]
VERB_IDX = {v: k + 1 for k, v in enumerate(F.VERBS)}
CLEAR = (1 << 0) | (1 << 5) | (1 << 2)  # cancel, clear, moved


def frames_of(items):
    out = []
    for i in items:
        if "title" in i:
            out.append(F.item_frame(i["id"], i["title"], i["text"]))
        else:
            title, _, text = i["text"].partition("\n")
            out.append(F.item_frame(i["id"], title, text))
    return out


def qx_channel(W, rq, table, n=25):
    q = Counter({t: 1.0 for t in rq["terms"]})
    for t in list(q):
        for d, sc in table.get(t, []):
            q[d] = max(q[d], 0.5 * sc)
    ex = W.bm25(q)
    order = sorted(ex, key=lambda k: -ex[k])
    return order[:n], ex, {k: r for r, k in enumerate(order[:100])}


def pair_rows(W, request, table):
    """(candidate ids into W.items, feature rows) for one request."""
    rq = F.request_frame(request)
    extra, qx, qx_rank = qx_channel(W, rq, table)
    found, lex, order = F.candidates(W, rq, extra)
    rank = {k: r for r, k in enumerate(order[:200])}
    nbr = W.neighbours()
    head = order[:5]
    head_threads = Counter(W.items[k]["thread"] for k in head)
    head_senders = Counter(W.items[k]["sender"] for k in head if W.items[k]["sender"])
    qterms = set(rq["terms"])
    rows, ids = [], []
    for k, chan in found.items():
        f = W.items[k]
        it = set(f["terms"])
        shared = qterms & it
        gap = min((abs(a - b) for a in rq["days"] for b in f["days"]), default=-1)
        j, ov = nbr[k]
        nf = W.items[j] if j >= 0 else None
        th = W.by_thread.get(f["thread"], [])
        newer_clear = any(W.items[x]["stamp"] and f["stamp"] and W.items[x]["stamp"] > f["stamp"] and
                          W.items[x]["status"] & CLEAR for x in th if x != k)
        newest = all(not (W.items[x]["stamp"] and f["stamp"] and W.items[x]["stamp"] > f["stamp"]) for x in th if x != k)
        r = {
            "bm25": round(lex.get(k, 0.0) * 10), "bm25_rank": rank.get(k, 200), "cover": round(100 * len(shared) / max(1, len(qterms))),
            "shared": len(shared), "title": len(qterms & f["title"]), "qx": round(qx.get(k, 0.0) * 10), "qx_rank": qx_rank.get(k, 100),
            "q_days": len(rq["days"]), "i_days": len(f["days"]), "day_exact": int(bool(rq["days"] & f["days"])),
            "day_gap": gap, "age": (F.NOW_DAY - f["stamp"]) if f["stamp"] else -999,
            "future": int(any(d >= F.NOW_DAY for d in f["days"])),
            "q_amt": len(rq["amts"]), "i_amt": len(f["amts"]), "amt_eq": int(bool(rq["amts"] & f["amts"])),
            "amt_above": int(bool(rq["amts"] and f["amts"] and max(f["amts"]) > max(rq["amts"]))),
            "names": len(rq["names"] & f["names"]),
            "verb": VERB_IDX.get(rq["verb"], 0), "q_status": rq["status"], "q_oblig": rq["oblig"],
            "nbr_overlap": round(100 * ov), "nbr_xor": bin(f["status"] ^ nf["status"]).count("1") if nf else -1,
            "nbr_newer": (int((nf["stamp"] or 0) > (f["stamp"] or 0)) if nf else -1),
            "nbr_clears": int(bool(nf and nf["status"] & CLEAR and not f["status"] & CLEAR)),
            "self_clears": int(bool(f["status"] & CLEAR and nf and not nf["status"] & CLEAR)),
            "thread_newer_clear": int(newer_clear), "thread_newest": int(newest), "thread_size": len(th),
            "head_links": head_threads.get(f["thread"], 0) + (head_senders.get(f["sender"], 0) if f["sender"] else 0),
            "chan": chan, "kind": F.KINDS.index(f["kind"]), "auto": f["auto"], "len": min(f["len"] // 200, 20),
        }
        for b, (n, _) in enumerate(F.STATUS):
            r[f"s_{n}"] = (f["status"] >> b) & 1
        for b, (n, _) in enumerate(F.OBLIG):
            r[f"o_{n}"] = (f["oblig"] >> b) & 1
        rows.append([r[x] for x in FEATS])
        ids.append(k)
    return ids, rows


def worlds(path, n=10**9):
    with gzip.open(path, "rt") as f:
        for i, line in enumerate(f):
            if i >= n:
                break
            yield json.loads(line)


def train(fold, out, ablate, n_train, n_synth, n_m2, rounds):
    import lightgbm as lgb
    import numpy as np

    t0 = time.time()
    fs = FOLDS[fold]
    suites = set(fs["suites"]) | {"synth", "m2"}
    files = [(f"{D}/train-worlds.jsonl.gz", n_train), (f"{D}/{fs['synth']}", n_synth), (f"{D}/m2-train-worlds.jsonl.gz", n_m2)]
    table, n_t = learn_table([p for p, _ in files], suites, 5, 3, 60)
    rng = random.Random(7)
    X, y, meta = [], [], Counter()
    for path, n in files:
        for w in worlds(path, n):
            tasks = [t for t in w["tasks"] if t["suite"] in suites]
            away = {x for t in w["tasks"] if t["suite"] not in suites for x in (t["pos"], t["decoy"])}
            # One variant a template: requests of one template share its fact and twin (M2 has several styles).
            keyed = {}
            for t in tasks:
                keyed.setdefault((t["template"], t["pos"]), []).append(t)
            hid = {k: rng.random() < 0.5 for k in keyed}
            drop = {(ts[0]["decoy"] if hid[k] else ts[0]["pos"]) for k, ts in keyed.items()}
            items = [i for i in w["items"] if i["id"] not in away and i["id"] not in drop]
            W = F.World(frames_of(items))
            idx = {f["id"]: k for k, f in enumerate(W.items)}
            reqs = [(t, hid[k]) for k, ts in keyed.items() for t in ts]
            rng.shuffle(reqs)
            for t, h in reqs[:80]:
                ids, rows = pair_rows(W, t["request"], table)
                target = idx.get(t["pos"]) if h else None
                for k, r in zip(ids, rows):
                    X.append(r)
                    y.append(int(k == target))
                meta["requests"] += 1
                meta["fact_in_cands"] += int(h and target in ids)
                meta["hidden"] += int(h)
    X = np.array(X, dtype=np.float32)
    y = np.array(y)
    keep = [k for k, f in enumerate(FEATS) if not any(f in GROUPS[g] for g in ablate)]
    params = {"objective": "binary", "learning_rate": 0.05, "num_leaves": 31, "min_data_in_leaf": 50,
              "feature_fraction": 0.9, "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1, "num_threads": 4,
              "scale_pos_weight": 5.0}
    model = lgb.train(params, lgb.Dataset(X[:, keep], y), rounds)
    os.makedirs(out, exist_ok=True)
    model.save_model(os.path.join(out, "model.txt"))
    json.dump(table, open(os.path.join(out, "table.json"), "w"))
    json.dump({"fold": fold, "ablate": ablate, "features": [FEATS[k] for k in keep], "rows": int(len(y)),
               "positives": int(y.sum()), "table_templates": n_t, "rounds": rounds, "seconds": round(time.time() - t0),
               **meta}, open(os.path.join(out, "meta.json"), "w"), indent=1)
    print(json.load(open(os.path.join(out, "meta.json"))))


def evaluate(model_dir, eval_path, out):
    import lightgbm as lgb
    import numpy as np

    meta = json.load(open(os.path.join(model_dir, "meta.json")))
    keep = [FEATS.index(f) for f in meta["features"]]
    model = lgb.Booster(model_file=os.path.join(model_dir, "model.txt"))
    table = json.load(open(os.path.join(model_dir, "table.json")))
    os.makedirs(out, exist_ok=True)
    t_ing = t_req = 0.0
    n_items = n_reqs = 0
    with open(os.path.join(out, "ranks.jsonl"), "w") as g:
        for w in worlds(eval_path):
            if not w["key"].startswith("days/") or not w["requests"]:
                continue
            t0 = time.perf_counter()
            W = F.World(frames_of(w["items"]))
            W.neighbours()
            t_ing += time.perf_counter() - t0
            n_items += W.N
            for r in w["requests"]:
                t1 = time.perf_counter()
                ids, rows = pair_rows(W, r["request"], table)
                p = model.predict(np.array(rows, dtype=np.float32)[:, keep]) if rows else []
                order = sorted(range(len(ids)), key=lambda k: -p[k])
                t_req += time.perf_counter() - t1
                n_reqs += 1
                g.write(json.dumps({"rid": r["rid"], "top": [W.items[ids[k]]["id"] for k in order[:100]],
                                    "p": [round(float(p[k]), 4) for k in order[:100]]}) + "\n")
    timing = {"ingest_us_item_python": round(1e6 * t_ing / max(1, n_items)),
              "request_ms_python": round(1e3 * t_req / max(1, n_reqs), 2), "items": n_items, "requests": n_reqs}
    json.dump(timing, open(os.path.join(out, "timing.json"), "w"))
    print(timing)


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["train", "eval"])
    a.add_argument("--fold", default="A")
    a.add_argument("--out", required=True)
    a.add_argument("--model")
    a.add_argument("--eval")
    a.add_argument("--ablate", default="")
    a.add_argument("--n-train", type=int, default=40)
    a.add_argument("--n-synth", type=int, default=80)
    a.add_argument("--n-m2", type=int, default=227)
    a.add_argument("--rounds", type=int, default=400)
    o = a.parse_args()
    if o.cmd == "train":
        train(o.fold, o.out, [x for x in o.ablate.split(",") if x], o.n_train, o.n_synth, o.n_m2, o.rounds)
    else:
        evaluate(o.model, o.eval, o.out)
