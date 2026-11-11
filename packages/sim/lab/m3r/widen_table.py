"""M3 retriever (D901): cross-fitted rank tables for the `pushRetrieve` trial. Each request gets the ranks of the
fold that held its suite out (never a model that trained on its template), so the funnel and days-calls measure
out-of-family retrieval on every train suite.

  python3 -I widen_table.py EVAL.jsonl.gz --fold RUN_DIR=train5,train6 --fold RUN_DIR=train1,train2 \
      --fold RUN_DIR=train3,train4 --days OUT_DAYS.jsonl --short OUT_SHORT.jsonl
Days rows: {seed, request, top}; short rows (n2-widen's format): {suite, seed, variant, request, top}.
"""
import argparse, gzip, json, os

if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("eval")
    a.add_argument("--fold", action="append", required=True)
    a.add_argument("--days", required=True)
    a.add_argument("--short", required=True)
    a.add_argument("--top", type=int, default=20)
    o = a.parse_args()
    owner = {}
    for spec in o.fold:
        run, suites = spec.split("=")
        ranks = {r["rid"]: r["top"] for r in map(json.loads, open(os.path.join(run, "ranks.jsonl")))}
        for s in suites.split(","):
            owner[s] = ranks
    nd = ns = miss = 0
    with gzip.open(o.eval, "rt") as f, open(o.days, "w") as fd, open(o.short, "w") as fs:
        for line in f:
            w = json.loads(line)
            for r in w["requests"]:
                suite = r["template"].split("/")[0]
                top = owner.get(suite, {}).get(r["rid"])
                if top is None:
                    miss += 1
                    continue
                if r["rid"].startswith("days/"):
                    seed = int(w["key"].split("/w")[1])
                    fd.write(json.dumps({"seed": seed, "request": r["request"], "top": top[: o.top]}) + "\n")
                    nd += 1
                else:
                    _, s, seed, variant, _t = r["rid"].split("/", 4)
                    fs.write(json.dumps({"suite": s, "seed": int(seed), "variant": variant, "request": r["request"],
                                         "top": top[: o.top]}) + "\n")
                    ns += 1
    print(f"days rows {nd}, short rows {ns}, requests with no fold {miss}")
