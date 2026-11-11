"""M3 TwinXor (D907): training and eval groups for the neural scorer, from frames.py's symbolic candidates.

One JSON line a world: {key, texts: [item text], twin: [index of each item's term-nearest partner, -1 if none],
reqs: [{rid, request, kind, template, cands: [item index], target: index into cands or -1, feats: [[int, ...]]}]}.
`feats` are framerank.py's 48 pair features (an optional input). Training worlds mirror the days runs (a template's
fact or its twin, never both); eval worlds are the days and M2 eval files as they are.

  python3 -I export_groups.py train --fold A --out groups-A.jsonl.gz
  python3 -I export_groups.py eval --eval eval.jsonl.gz --table TABLE.json --out groups-eval.jsonl.gz
"""
import argparse, gzip, json, os, random, sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames as F  # noqa: E402
import framerank as R  # noqa: E402


def world_groups(args):
    w, suites, table, seed, train = args
    rng = random.Random(seed)
    if train:
        tasks = [t for t in w["tasks"] if t["suite"] in suites]
        away = {x for t in w["tasks"] if t["suite"] not in suites for x in (t["pos"], t["decoy"])}
        keyed = {}
        for t in tasks:
            keyed.setdefault((t["template"], t["pos"]), []).append(t)
        hid = {k: rng.random() < 0.5 for k in keyed}
        drop = {(ts[0]["decoy"] if hid[k] else ts[0]["pos"]) for k, ts in keyed.items()}
        items = [i for i in w["items"] if i["id"] not in away and i["id"] not in drop]
        reqs = [(t["request"], t["pos"] if hid[k] else None, "hidden" if hid[k] else "control", t["template"], "")
                for k, ts in keyed.items() for t in ts]
        rng.shuffle(reqs)
        reqs = reqs[:80]
        key = f"train/{w.get('seed', '')}"
    else:
        items = w["items"]
        reqs = [(r["request"], r["planted"] if r["kind"] == "hidden" else None, r["kind"], r["template"], r["rid"])
                for r in w["requests"]]
        key = w["key"]
    W = F.World(R.frames_of(items))
    idx = {f["id"]: k for k, f in enumerate(W.items)}
    nbr = W.neighbours()
    out = []
    for text, pos, kind, tpl, rid in reqs:
        ids, rows = R.pair_rows(W, text, table)
        target = ids.index(idx[pos]) if pos is not None and idx.get(pos) in ids else -1
        planted = idx.get(pos) if pos is not None else None
        out.append({"rid": rid, "request": text, "kind": kind, "template": tpl, "cands": ids, "target": target,
                    "fact_lost": int(pos is not None and target < 0), "feats": rows})
    texts = []
    for i in items:
        texts.append(f"{i['title']}\n{i['text']}" if "title" in i else i["text"])
    return {"key": key, "ids": [f["id"] for f in W.items], "texts": texts, "twin": [j for j, _ in nbr], "reqs": out}


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["train", "eval"])
    a.add_argument("--fold", default="A")
    a.add_argument("--eval")
    a.add_argument("--table")
    a.add_argument("--out", required=True)
    a.add_argument("--n-train", type=int, default=60)
    a.add_argument("--n-synth", type=int, default=150)
    a.add_argument("--n-m2", type=int, default=227)
    a.add_argument("--procs", type=int, default=4)
    o = a.parse_args()
    if o.cmd == "train":
        fs = R.FOLDS[o.fold]
        suites = set(fs["suites"]) | {"synth", "m2"}
        files = [(f"{R.D}/train-worlds.jsonl.gz", o.n_train), (f"{R.D}/{fs['synth']}", o.n_synth),
                 (f"{R.D}/m2-train-worlds.jsonl.gz", o.n_m2)]
        table, _ = R.learn_table([p for p, _ in files], suites, 5, 3, 60)
        json.dump(table, open(o.out.replace(".jsonl.gz", ".table.json"), "w"))
        jobs = [(w, suites, table, k, True) for p, n in files for k, w in enumerate(R.worlds(p, n))]
    else:
        table = json.load(open(o.table))
        jobs = [(w, set(), table, 0, False) for w in R.worlds(o.eval) if w["key"].startswith("days/")]
    n = lost = reqs = 0
    with Pool(o.procs) as pool, gzip.open(o.out, "wt") as g:
        for row in pool.imap(world_groups, jobs, chunksize=1):
            g.write(json.dumps(row) + "\n")
            n += 1
            reqs += len(row["reqs"])
            lost += sum(r["fact_lost"] for r in row["reqs"])
    print(f"{n} worlds, {reqs} requests ({lost} with the fact outside the candidates) -> {o.out}")
