"""M12 (D1000-D1009, docs/research/m12-pool.md): data for the pool models.

Reads m12-export.ts's term files (M2 v2 worlds as the engine tokenizes them) and M1's teacher scores (t8b: per request
group, ten item keys and the 8B scorer's logit each). Simulated data only.
"""
import gzip
import json
import math
from collections import Counter

import numpy as np
import scipy.sparse as sp

K1, B, TITLE_BOOST = 1.2, 0.75, 2.0


def read_jsonl(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def load_teacher(path):
    """group id ("family/world/task/request") -> {item key: teacher logit}."""
    out = {}
    for r in read_jsonl(path):
        out[r["group"]] = dict(zip(r["keys"], r["s"]))
    return out


def load_synth(path, teacher=None):
    """worlds: list of {world, items: [{id, tf: Counter, len}], reqs: [{gid, q, fact, decoy, neutrals, teacher}]}"""
    worlds = []
    for w in read_jsonl(path):
        items = []
        for it in w["items"]:
            tf = Counter(it["text"])
            for t in it["title"]:
                tf[t] += TITLE_BOOST
            items.append({"id": it["id"], "tf": tf, "len": len(it["text"]) + len(it["title"]), "chars": it["chars"]})
        reqs = []
        for t in w["tasks"]:
            for r in t["requests"]:
                gid = f"{t['family']}/{w['world']}/{t['id']}/{r['id']}"
                reqs.append({"gid": gid, "q": r["q"], "fact": t["fact"], "decoy": t["decoy"], "neutrals": t["neutrals"],
                             "style": r["style"], "lang": r["lang"], "family": t["family"],
                             "teacher": (teacher or {}).get(gid)})
        worlds.append({"world": w["world"], "items": items, "reqs": reqs})
    return worlds


def load_fit(path):
    """Funnel corpus worlds (sim): items as in load_synth, tasks: [{template, planted, q}]."""
    worlds = []
    for w in read_jsonl(path):
        items = []
        for it in w["items"]:
            tf = Counter(it["text"])
            for t in it["title"]:
                tf[t] += TITLE_BOOST
            items.append({"id": it["id"], "tf": tf, "len": len(it["text"]) + len(it["title"]), "chars": it["chars"]})
        worlds.append({"key": (w["suite"], w["seed"], w["variant"]), "items": items, "tasks": w["tasks"]})
    return worlds


class Vocab:
    def __init__(self, terms):
        self.terms = list(terms)
        self.id = {t: i for i, t in enumerate(self.terms)}

    def __len__(self):
        return len(self.terms)


def item_vocab(worlds, min_df=3, cap=40000):
    df = Counter()
    for w in worlds:
        for it in w["items"]:
            df.update(it["tf"].keys())
    terms = [t for t, n in df.most_common() if n >= min_df][:cap]
    return Vocab(terms)


def req_vocab(worlds, min_df=2, cap=30000):
    df = Counter()
    for w in worlds:
        for r in w["reqs"]:
            df.update(set(r["q"]))
    return Vocab([t for t, n in df.most_common() if n >= min_df][:cap])


def bm25_matrix(items, vocab, idf=None):
    """CSR (items x vocab) of BM25 term weights (idf over these items unless given). Terms outside vocab dropped."""
    n = len(items)
    avg = max(1.0, sum(it["len"] for it in items) / max(n, 1))
    if idf is None:
        df = Counter()
        for it in items:
            df.update(t for t in it["tf"] if t in vocab.id)
        idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
    rows, cols, vals = [], [], []
    for i, it in enumerate(items):
        norm = K1 * (1 - B + B * it["len"] / avg)
        for t, f in it["tf"].items():
            j = vocab.id.get(t)
            if j is None:
                continue
            rows.append(i)
            cols.append(j)
            vals.append(idf.get(t, 0.0) * f * (K1 + 1) / (f + norm))
    return sp.csr_matrix((np.array(vals, np.float32), (rows, cols)), shape=(n, len(vocab))), idf
