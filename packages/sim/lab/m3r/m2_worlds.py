"""M3 (D900): M2's synthetic worlds (`eden-synth` v0, split by family) as M3's training worlds and as an eval.

Each M2 world's items are set beside one export world's base items (its suites' facts and decoys taken out, about
1,500 items), so a request's fact competes with a user-sized inbox. Training rows: one task per request (every style
and language), suite "m2", the fact as positive, its decoy as the first hard negative. Eval rows (m3r/prep.py's
format): each request twice, "hidden" with the fact planted and "control" with the decoy, and a BM25 top 15 / 50 as
the lexical list (this screen's own BM25, not Eden's pool: M2's worlds are not yet a funnel suite).

  python3 -I m2_worlds.py --m2 worlds-train.jsonl --base train-worlds.jsonl.gz --train-out m2-train-worlds.jsonl.gz
  python3 -I m2_worlds.py --m2 worlds-test.jsonl --base train-worlds.jsonl.gz --eval-out eval-m2.jsonl.gz
"""
import argparse, gzip, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qexpand import bm25_rank, terms  # noqa: E402


def base_worlds(path, n):
    out = []
    with gzip.open(path, "rt") as f:
        for line in f:
            w = json.loads(line)
            planted = {x for t in w["tasks"] for x in (t["pos"], t["decoy"])}
            out.append([i for i in w["items"] if i["id"] not in planted])
            if len(out) >= n:
                break
    return out


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--m2", required=True)
    a.add_argument("--base", required=True)
    a.add_argument("--train-out")
    a.add_argument("--eval-out")
    a.add_argument("--base-worlds", type=int, default=20)
    o = a.parse_args()
    bases = base_worlds(o.base, o.base_worlds)
    m2 = [json.loads(l) for l in open(o.m2)]
    if o.train_out:
        with gzip.open(o.train_out, "wt") as g:
            for k, w in enumerate(m2):
                own = [{"id": f"{w['id']}:{i['id']}", "title": i["title"], "text": i["text"][:1200]}
                       for i in w["items"]]
                tasks = [{"suite": "m2", "template": t["family"], "request": r["text"], "pos": f"{w['id']}:{t['fact']}",
                          "decoy": f"{w['id']}:{t['decoy']}"} for t in w["tasks"] for r in t["requests"]]
                g.write(json.dumps({"seed": k, "items": bases[k % len(bases)] + own, "tasks": tasks}) + "\n")
        print(f"{len(m2)} train worlds -> {o.train_out}")
    if o.eval_out:
        n = 0
        with gzip.open(o.eval_out, "wt") as g:
            for k, w in enumerate(m2):
                items = [{"id": i["id"], "text": f"{i['title']}\n{i['text'][:1200]}"} for i in bases[k % len(bases)]]
                items += [{"id": f"{w['id']}:{i['id']}", "text": f"{i['title']}\n{i['text'][:1200]}"}
                          for i in w["items"]]
                reqs = []
                for t in w["tasks"]:
                    for r in t["requests"]:
                        q = {x: 1.0 for x in terms(r["text"])}
                        lex = bm25_rank(items, q, top=50)
                        for kind, x in (("hidden", t["fact"]), ("control", t["decoy"])):
                            reqs.append({"rid": f"days/m2/{w['id']}/{r['id']}/{kind}", "request": r["text"],
                                         "planted": f"{w['id']}:{x}", "kind": kind, "template": f"m2/{t['family']}",
                                         "style": r["style"], "pool15": lex[:15], "pool50": lex})
                            n += 1
                g.write(json.dumps({"key": f"days/m2/{w['id']}", "items": items, "requests": reqs}) + "\n")
        print(f"{len(m2)} eval worlds, {n} rows -> {o.eval_out}")
