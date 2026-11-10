"""The embedding retrieval screen's scoring, with no Modal and no numpy in it (M0): which planted items an embedding
of the request ranks in its top k, against Eden's lexical pool (the funnel's `pushPoolAt`, the planted item's place
in the push's candidate pool), split by whether the item shares any word with the request (A15's target set:
docs/research/a15-retrieval.md). `embed_screen.py` computes the ranks on Modal; `tests/test_embed_score.py` tests
this with `python3 -I -m unittest`.
"""
import json
import re

# screen.py's (packages/sim/lab/a15/) stop list and term rule, so "shares no word" means what A15 meant.
STOP = set("""a an the and or of to in on at for from by with my me i we our us you your it its is are be this that
these those as so if not no do does did will would can could should have has had was were am pm please just get
some any all about up out into over than then there their they them he she his her what when where who which how""".split())
TEXT_CHARS = 500
GROUPS = ("all", "no shared word", "not in lexical pool", "not surfaced by the default")


def terms(text):
    return [w for w in re.findall(r"[a-z0-9£$€]+", text.lower()) if w not in STOP and len(w) > 1]


def item_text(item):
    """What is embedded for an item: its title and the head of its text (A15's embed.py)."""
    return f"{item['title']}. {item['text'][:TEXT_CHARS]}"


def shares_word(request, item):
    return bool(set(terms(request)) & set(terms(item["title"] + " " + item["text"][:1200])))


def load_corpus(path, variants=("hidden", "control")):
    with open(path) as f:
        worlds = [json.loads(line) for line in f if line.strip()]
    return [w for w in worlds if w["variant"] in variants]


def check_train(worlds):
    """The screen runs on train suites: a held-out world in the dump is refused (measurement only)."""
    bad = sorted({w["suite"] for w in worlds if not w["suite"].startswith("train")})
    if bad:
        raise ValueError(f"the corpus holds non-train suites ({', '.join(bad)}): dump train only")


def pack(worlds):
    """Unique texts (a seed's background world is shared by its suites) and, per world, each item's text index and
    each task's request, planted index and template: what goes to the GPU."""
    texts, index = [], {}

    def ref(t):
        if t not in index:
            index[t] = len(texts)
            texts.append(t)
        return index[t]

    packed = []
    for w in worlds:
        ids = [x["id"] for x in w["items"]]
        pos = {i: k for k, i in enumerate(ids)}
        packed.append({
            "key": [w["suite"], w["seed"], w["variant"]],
            "items": [ref(item_text(x)) for x in w["items"]],
            "tasks": [{"template": t["template"], "request": t["request"], "planted": pos.get(t["planted"], -1)}
                      for t in w["tasks"]],
        })
    return texts, packed


def rank_of(scores, idx):
    """1-based rank of `idx` by score, ties counted against it (an item tied with others is not ahead of them)."""
    s = scores[idx]
    return sum(1 for x in scores if x >= s)


def funnel_rows(path):
    with open(path) as f:
        rows = json.load(f)["perTask"]
    return {(r["suite"], r["seed"], r["variant"], r["template"]): r for r in rows}


def in_pool(row, k):
    """The planted item among the first k of the push's lexical pool (`pushPoolAt`, -1 or absent: not in it)."""
    at = row.get("pushPoolAt", -1) if row else -1
    return at is not None and 0 <= at < k


def screen(worlds, ranks, rows, ks=(1, 5, 10)):
    """Per variant and group (all; shares no word with the request; not in the lexical pool at all): tasks, and for
    each k how many planted items the embedding ranks in its top k, the lexical pool holds in its first k, either,
    and the embedding alone. `ranks`: (suite, seed, variant, template) -> the embedding's rank of the planted item."""
    out = {}
    for w in worlds:
        items = {x["id"]: x for x in w["items"]}
        for t in w["tasks"]:
            key = (w["suite"], w["seed"], w["variant"], t["template"])
            if not t["planted"] or t["planted"] not in items or key not in ranks:
                continue
            row = rows.get(key)
            groups = ["all"]
            if not shares_word(t["request"], items[t["planted"]]):
                groups.append("no shared word")
            if not in_pool(row, 10 ** 9):
                groups.append("not in lexical pool")
            if row and not (row.get("delivered") or row.get("askCited")):
                groups.append("not surfaced by the default")
            for g in groups:
                s = out.setdefault(w["variant"], {}).setdefault(g, {"tasks": 0, **{f"k{k}": {
                    "embedding": 0, "lexical": 0, "either": 0, "embeddingOnly": 0} for k in ks}})
                s["tasks"] += 1
                for k in ks:
                    e = ranks[key] <= k
                    lx = in_pool(row, k)
                    c = s[f"k{k}"]
                    c["embedding"] += e
                    c["lexical"] += lx
                    c["either"] += e or lx
                    c["embeddingOnly"] += e and not lx
    return out


def lines(summary, model):
    """The report as text: hidden tasks (planted facts) and control tasks (decoys: what an extra slot would bring)."""
    out = [f"embedding screen ({model}; lab, M0): planted item in the top k by embedding vs in the first k of the "
           "push's lexical pool (pushPoolAt)"]
    for variant in ("hidden", "control"):
        what = "planted facts" if variant == "hidden" else "decoys (look-alikes: an extra slot would bring these)"
        groups = summary.get(variant, {})
        for g in [g for g in GROUPS if g in groups]:
            s = groups[g]
            cells = "  ".join(f"k{k[1:]}: emb {c['embedding']} lex {c['lexical']} either {c['either']} "
                              f"emb-only {c['embeddingOnly']}" for k, c in s.items() if k.startswith("k"))
            out.append(f"  {variant:7s} {g:28s} n {s['tasks']:4d}  {cells}   ({what})")
    return out
