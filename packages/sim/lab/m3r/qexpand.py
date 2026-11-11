"""M3 (D902): query-side term expansion learned as a lookup table, no model anywhere: from training worlds' (request,
fact) pairs, which item words a request word predicts (counted once per template, against how common the item word
is in the worlds), then a BM25 search of each eval world with the request's words plus their expansions. Writes a
run directory (ranks.jsonl) that score.py reads like a model's.

  python3 -I qexpand.py --train train-worlds.jsonl.gz[,synth-a-worlds.jsonl.gz] --suites train1,train2,train3,train4,synth \
      --eval eval.jsonl.gz --out RUN_DIR [--per-term 5] [--min-templates 3] [--weight 0.5]
"""
import argparse, gzip, json, math, os, re
from collections import Counter, defaultdict

STOP = set("""a an the and or of to in on at for from by with is are was were be been it its this that these those
i me my we our you your he she they them their his her as if but not no so do does did done have has had will would
can could should may might must please just also about into than then there here what when where which who whom why
how all any some each other more most such only own same too very up out over under again further once am get got
make made set send book pay put take let new today tomorrow week this next last re fw fwd hi dear thanks regards""".split())
TOKEN = re.compile(r"[a-z0-9][a-z0-9'£$.-]*")


def terms(text):
    return [t.strip(".'-") for t in TOKEN.findall(text.lower()) if t.strip(".'-") and t.strip(".'-") not in STOP]


def worlds(path):
    with gzip.open(path, "rt") as f:
        for line in f:
            yield json.loads(line)


def learn(files, suites, per_term, min_templates, max_worlds):
    """q -> [(d, weight)]: item words d that the request word q's facts hold far more often than items at large."""
    pair = defaultdict(Counter)  # q -> d -> templates
    qn = Counter()  # q -> templates
    df, n_items = Counter(), 0
    seen = set()
    for path in files:
        for wi, w in enumerate(worlds(path)):
            if wi >= max_worlds:
                break
            ids = {i["id"]: i for i in w["items"]}
            for i in w["items"][:400]:
                df.update(set(terms(f"{i['title']} {i['text']}")))
                n_items += 1
            for t in w["tasks"]:
                if t["suite"] not in suites or t["pos"] not in ids:
                    continue
                key = (t["suite"], t["template"])
                if key in seen:
                    continue
                seen.add(key)
                it = ids[t["pos"]]
                q = set(terms(t["request"]))
                d = set(terms(f"{it['title']} {it['text']}"))
                for a in q:
                    qn[a] += 1
                    for b in d - q:
                        pair[a][b] += 1
    table = {}
    for a, row in pair.items():
        if qn[a] < min_templates:
            continue
        cand = []
        for b, c in row.items():
            if c < min_templates:
                continue
            p = c / qn[a]
            bg = (df[b] + 1) / (n_items + 1)
            lift = p / bg
            if p >= 0.2 and lift >= 5:
                cand.append((b, p * math.log(lift)))
        cand.sort(key=lambda x: -x[1])
        if cand:
            top = cand[:per_term]
            m = max(x[1] for x in top)
            table[a] = [(b, round(s / m, 3)) for b, s in top]
    return table, len(seen)


def bm25_rank(items, query, k1=1.2, b=0.75, top=100):
    docs = [terms(i["text"]) for i in items]
    N = len(docs)
    avg = sum(len(d) for d in docs) / max(1, N)
    df = Counter()
    tfs = []
    for d in docs:
        c = Counter(d)
        tfs.append(c)
        df.update(c.keys())
    scores = []
    for k, (c, d) in enumerate(zip(tfs, docs)):
        s = 0.0
        for t, w in query.items():
            if t in c:
                idf = math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5))
                s += w * idf * c[t] * (k1 + 1) / (c[t] + k1 * (1 - b + b * len(d) / avg))
        if s > 0:
            scores.append((s, k))
    scores.sort(reverse=True)
    return [items[k]["id"] for _, k in scores[:top]]


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--train", required=True)
    a.add_argument("--suites", required=True)
    a.add_argument("--eval", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--per-term", type=int, default=5)
    a.add_argument("--min-templates", type=int, default=3)
    a.add_argument("--weight", type=float, default=0.5)
    a.add_argument("--max-worlds", type=int, default=60)
    a.add_argument("--plain", action="store_true", help="BM25 of the request alone (the screen's own baseline)")
    o = a.parse_args()
    table, n_t = learn(o.train.split(","), set(o.suites.split(",")), o.per_term, o.min_templates, o.max_worlds)
    print(f"learned from {n_t} templates: {len(table)} request words with expansions")
    os.makedirs(o.out, exist_ok=True)
    json.dump(table, open(os.path.join(o.out, "table.json"), "w"))
    with open(os.path.join(o.out, "ranks.jsonl"), "w") as f:
        for w in worlds(o.eval):
            if not w["key"].startswith("days/"):
                continue
            for r in w["requests"]:
                q = Counter()
                for t in terms(r["request"]):
                    q[t] = 1.0
                if not o.plain:
                    for t in list(q):
                        for d, s in table.get(t, []):
                            q[d] = max(q[d], o.weight * s)
                f.write(json.dumps({"rid": r["rid"], "top": bm25_rank(w["items"], q)}) + "\n")
    print(f"-> {o.out}")
