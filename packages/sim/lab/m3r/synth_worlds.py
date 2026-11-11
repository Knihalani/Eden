"""M3 retriever (D900): `m3-synth.ts`'s generated templates as training worlds, in m3-export.ts's format.

Each world is one export world's base items (its suites' facts and decoys taken out) plus a sample of generated
templates: the fact, its all-clear twin (the task's decoy) and a look-alike, all as items, with suite "synth". A
template too close to a held-out family's (TF-IDF cosine of the request, or of the fact's text, above --max-sim
against any template of the --heldout suites in the export file) is dropped and counted: no held-out family is
learned through a near copy.

  python3 -I synth_worlds.py --synth S.jsonl --worlds train-worlds.jsonl.gz --heldout train5,train6 \
      --n-worlds 150 --per-world 96 --out synth-worlds.jsonl.gz
"""
import argparse, gzip, json, random, re


def load_synth(path):
    out, seen = [], set()
    for line in open(path):
        r = json.loads(line)
        for t in r["templates"]:
            key = t["request"].strip().lower()
            if key in seen:
                continue
            seen.add(key)
            t["domain"] = r["domain"]
            out.append(t)
    return out


def heldout_texts(worlds_path, heldout):
    with gzip.open(worlds_path, "rt") as f:
        w = json.loads(f.readline())
    ids = {i["id"]: i for i in w["items"]}
    reqs, facts = [], []
    for t in w["tasks"]:
        if t["suite"] in heldout:
            reqs.append(t["request"])
            it = ids.get(t["pos"])
            if it:
                facts.append(f"{it['title']} {it['text']}")
    return reqs, facts


def too_close(synth, reqs, facts, max_sim):
    from sklearn.feature_extraction.text import TfidfVectorizer

    a = [t["request"] for t in synth]
    b = [f"{t['fact']['title']} {t['fact']['text']}" for t in synth]
    vec = TfidfVectorizer(sublinear_tf=True, stop_words="english").fit(a + b + reqs + facts)
    s1 = (vec.transform(a) @ vec.transform(reqs).T).max(axis=1).toarray().ravel()
    s2 = (vec.transform(b) @ vec.transform(facts).T).max(axis=1).toarray().ravel()
    return [max(x, y) > max_sim for x, y in zip(s1, s2)], s1, s2


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--synth", required=True)
    a.add_argument("--worlds", required=True)
    a.add_argument("--heldout", default="train5,train6")
    a.add_argument("--max-sim", type=float, default=0.5)
    a.add_argument("--n-worlds", type=int, default=150)
    a.add_argument("--per-world", type=int, default=96)
    a.add_argument("--out", required=True)
    o = a.parse_args()
    synth = load_synth(o.synth)
    reqs, facts = heldout_texts(o.worlds, set(o.heldout.split(",")))
    drop, s1, s2 = too_close(synth, reqs, facts, o.max_sim)
    kept = [t for t, d in zip(synth, drop) if not d]
    print(f"{len(synth)} distinct templates; {sum(drop)} dropped as close to {o.heldout} (max sim > {o.max_sim}); "
          f"{len(kept)} kept; request sim p50 {sorted(s1)[len(s1) // 2]:.2f}, fact sim p50 {sorted(s2)[len(s2) // 2]:.2f}")
    rng = random.Random(7)
    n = 0
    with gzip.open(o.worlds, "rt") as f, gzip.open(o.out, "wt") as g:
        for line in f:
            if n >= o.n_worlds:
                break
            w = json.loads(line)
            planted = {x for t in w["tasks"] for x in (t["pos"], t["decoy"])}
            items = [i for i in w["items"] if i["id"] not in planted]
            tasks = []
            for k, t in enumerate(rng.sample(kept, min(o.per_world, len(kept)))):
                base = f"synth:{slug(t['name'])}-{k}"
                for tag, part in (("f", t["fact"]), ("t", t["twin"]), ("l", t["lookalike"])):
                    items.append({"id": f"{base}:{tag}", "title": part["title"], "text": part["text"]})
                tasks.append({"suite": "synth", "template": slug(t["name"]), "request": t["request"],
                              "pos": f"{base}:f", "decoy": f"{base}:t"})
            g.write(json.dumps({"seed": w["seed"], "items": items, "tasks": tasks}) + "\n")
            n += 1
    print(f"{n} worlds -> {o.out}")
