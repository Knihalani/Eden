"""M11 (D970-D979): the training and screening data for the intent micro-expansion model.

Reads m11-export.ts's files (items.jsonl, worlds.jsonl; regenerate them at $0, they are deterministic):

  bun packages/sim/src/lab/m11-export.ts --suites train,reworded,longtail --seeds 41-44 --out .local/m11/sim
  bun packages/sim/src/lab/m11-export.ts --suites heldout10,heldout11,heldout13,heldout14 --seeds 41-44 --out .local/m11/ho

The split (fixed before any training, docs/research/m11-intent.md §1):
  - held-out families: every item planted in a train5, train6, train5r, train6r or longtail world, at any seed;
  - held-out base: every item of a seed 41 or 42 world (the funnel's seeds), so no screened world's background was
    trained on either;
  - training: the rest (seed 43-44 background, train1-4 and heldout10/11/13/14 planted items at seeds 43-44), plus
    M2 v2's train split when it is here (synth.py).
Targets: the item's Haiku requests as the engine stems them (`fullTerms`: intent-v2, every item read; else
`shippedTerms`). Inputs: hashed word, character 3/4-gram and word-bigram ids (m3r/binnet.py's `grams`, CRC-32).
"""
import json, os, re, zlib
from collections import Counter

HELD_SUITES = {"train5", "train6", "train5r", "train6r", "longtail"}
SCREEN_SEEDS = {41, 42}
WORD = re.compile(r"[a-z0-9£$€]+")


def grams(text, buckets, cap=400, char=True, bigram=True):
    """Hashed features of a text: words, char 3/4-grams inside words, word bigrams; sorted ids, at most `cap`."""
    words = WORD.findall(text.lower())[:200]
    out = set()
    for w in words:
        out.add(zlib.crc32(b"w" + w.encode()) % buckets)
        if char:
            p = f"<{w}>"
            for n in (3, 4):
                for k in range(len(p) - n + 1):
                    out.add(zlib.crc32(b"c" + p[k : k + n].encode()) % buckets)
    if bigram:
        for a, b in zip(words, words[1:]):
            out.add(zlib.crc32(f"b{a} {b}".encode()) % buckets)
    return sorted(out)[:cap]


def term_bucket(term, buckets):
    """An output term's bucket: the stemmed request term (engine `intentTerms`) hashed, so the model holds no strings."""
    return zlib.crc32(b"t" + term.encode()) % buckets


def read_jsonl(p):
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def load(root=".local/m11"):
    items, worlds = {}, []
    for d in ("sim", "ho"):
        for it in read_jsonl(os.path.join(root, d, "items.jsonl")):
            items.setdefault(it["h"], it)
        worlds += read_jsonl(os.path.join(root, d, "worlds.jsonl"))
    held_family, screen_base, seen_train = set(), set(), set()
    for w in worlds:
        if w["suite"] in HELD_SUITES:
            held_family.update(w["planted"])
        if w["seed"] in SCREEN_SEEDS:
            screen_base.update(w["hashes"])
    for h, it in items.items():
        it["target"] = it.get("fullTerms") or it.get("shippedTerms")
        it["split"] = "held" if (h in held_family or h in screen_base) else "train"
    return items, worlds


def twins(worlds):
    """(fact, look-alike, request terms, suite, seed, template) for each hidden task with a control twin."""
    ctl = {}
    for w in worlds:
        if w["variant"] == "control":
            for t in w["tasks"]:
                ctl[(w["suite"], w["seed"], t["template"])] = t["planted"]
    out = []
    for w in worlds:
        if w["variant"] != "hidden":
            continue
        for t in w["tasks"]:
            c = ctl.get((w["suite"], w["seed"], t["template"]))
            if t["planted"] and c and c != t["planted"]:
                out.append((t["planted"], c, t["terms"], w["suite"], w["seed"], t["template"]))
    return out


def target_weights(it):
    """Request-term weights: the share of the item's requests holding the term (0..1)."""
    reqs = it["target"] or []
    c = Counter()
    for r in reqs:
        for t in set(r):
            c[t] += 1
    n = max(1, len(reqs))
    return {t: v / n for t, v in c.items()}


def item_text(it):
    return f"{it['title']}\n{it['text']}"


if __name__ == "__main__":
    items, worlds = load()
    sp = Counter(it["split"] for it in items.values())
    tg = Counter((it["split"], it["target"] is not None) for it in items.values())
    print("items", len(items), dict(sp), dict(tg), "worlds", len(worlds), "twin pairs", len(twins(worlds)))
    vocab = Counter(t for it in items.values() if it["split"] == "train" and it["target"] for r in it["target"] for t in set(r))
    print("train request vocab", len(vocab), "with df>=3", sum(v >= 3 for v in vocab.values()))
    new = Counter()
    for it in items.values():
        if it["split"] == "train" and it["target"]:
            own = set(it["terms"])
            for t, w in target_weights(it).items():
                new["in" if t in own else "new"] += 1
    print("target terms in item / new:", dict(new))
