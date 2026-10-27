"""R10: retrieval as nearest labelled prompt (the cue bank), against R8's harness.

Every live memory owns exemplar prompts compiled at sleep (`r10_gen.py`): "needs" (prompts that need it) and "near"
(near-miss prompts that do not), and the repo shares a background bank of prompts that need no memory. At hook time a
prompt is compared with exemplars, prompt to prompt, by TF-IDF cosine over content words and character 4-grams (no
model, no embedding). A memory m is admitted when
    pos(m) >= theta   and   pos(m) - max(neg(m), bg) >= delta,
pos(m) = best match among m's needs and its own text, neg(m) = best match among m's near misses, bg = best background
match. Admitted rows are ranked by pos. theta, delta, the word/char mix and the cue text (prompt alone, or with its
context) are tuned on R1 dev only, exactly as R8 tuned its gates (maximize r@4 + 0.1 * precision at a dev FIR cap);
R1 test (hand and qwen authors) and R8's test_nim (kimi-k3) are scored once.

Usage (from benchmarks/memory-cues): python nim/r10_eval.py nim/out/r10-bank-gemma-4-31b-it.json [--out FILE]
"""
import argparse, collections, itertools, json, math, os, re, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from lexpy import BM25F, toks, ctx_cue

ap = argparse.ArgumentParser()
ap.add_argument("bank")
ap.add_argument("--out")
ap.add_argument("--no-near", action="store_true", help="ablation: ignore the near-miss exemplars")
ap.add_argument("--no-background", action="store_true", help="ablation: no background bank")
ap.add_argument("--needs", type=int, default=12, help="ablation: needs per memory")
args = ap.parse_args()

MEMS = json.load(open("fixture/memories.json"))
LIVE = [m for m in MEMS if not m["superseded_by"]]
R1 = json.load(open("fixture/cues.json"))
NIM = json.load(open("fixture/cues-nim.json"))
CUES = R1 + NIM
C = {c["id"]: c for c in CUES}
VIS = {c["id"]: [i for i, m in enumerate(LIVE) if m["scope"] in ("", c["scope"])] for c in CUES}
K, KMAX = 4, 6
B = json.load(open(args.bank))
BANK, BACKGROUND = B["bank"], ([] if args.no_background else B["background"])
DEV = [q for q in C if C[q]["split"] == "dev"]
DEV_NEG_TEXT = [C[q]["cue"] for q in DEV if not C[q]["gold"]]


# ---------------- representation: TF-IDF over content words and character 4-grams ----------------
def words(text):
    return [t for t in toks(text) if re.fullmatch(r"[a-z0-9]+", t)]


def grams(text):
    out = []
    for w in words(text):
        w = f" {w} "
        out += [w[i:i + 4] for i in range(max(1, len(w) - 3))]
    return out


class Space:
    """Sparse TF-IDF space over a document list; cosine of a query with every document via an inverted index."""

    def __init__(self, docs, feats):
        self.feats = feats
        bags = [collections.Counter(feats(d)) for d in docs]
        df = collections.Counter(t for b in bags for t in b)
        n = len(docs)
        self.idf = {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}
        post = collections.defaultdict(list)
        for i, b in enumerate(bags):
            v = {t: (1 + math.log(c)) * self.idf[t] for t, c in b.items()}
            norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
            for t, x in v.items():
                post[t].append((i, x / norm))
        self.post = {t: (np.array([i for i, _ in p]), np.array([x for _, x in p])) for t, p in post.items()}
        self.n = n

    def cos(self, text):
        b = collections.Counter(self.feats(text))
        v = {t: (1 + math.log(c)) * self.idf[t] for t, c in b.items() if t in self.idf}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        acc = np.zeros(self.n)
        for t, x in v.items():
            idx, w = self.post[t]
            np.add.at(acc, idx, w * x / norm)
        return acc


# Exemplar documents: (owner index or -1, kind) with kind in need / text / near / bg / devneg.
DOCS, OWNER, KIND = [], [], []
for i, m in enumerate(LIVE):
    entry = BANK.get(m["id"], {"needs": [], "near": []})
    for t in entry["needs"][: args.needs]:
        DOCS.append(t); OWNER.append(i); KIND.append("need")
    DOCS.append(m["text"]); OWNER.append(i); KIND.append("text")
    if not args.no_near:
        for t in entry["near"]:
            DOCS.append(t); OWNER.append(i); KIND.append("near")
for t in BACKGROUND:
    DOCS.append(t); OWNER.append(-1); KIND.append("bg")
for t in DEV_NEG_TEXT:
    DOCS.append(t); OWNER.append(-1); KIND.append("devneg")
OWNER, KIND = np.array(OWNER), np.array(KIND)
WORD, CHAR = Space(DOCS, words), Space(DOCS, grams)
IS_POS = np.isin(KIND, ["need", "text"]); IS_NEAR = KIND == "near"; IS_BG = np.isin(KIND, ["bg", "devneg"])


def query_text(c, mode):
    return c["cue"] if mode == "prompt" else ctx_cue(c["cue"], c["last_paths"], c["prev_turn"])


def features(q, mode, alpha):
    """Per visible memory: pos, neg; and the prompt's background match (leave-one-out for dev negatives)."""
    c = C[q]; text = query_text(c, mode)
    s = alpha * WORD.cos(text) + (1 - alpha) * CHAR.cos(text)
    bg_mask = IS_BG & ~((KIND == "devneg") & (np.array(DOCS, dtype=object) == c["cue"]))
    bg = float(s[bg_mask].max()) if bg_mask.any() else 0.0
    vis = VIS[q]
    pos = np.full(len(vis), 0.0); neg = np.full(len(vis), 0.0)
    where = {m: j for j, m in enumerate(vis)}
    for d in np.nonzero(IS_POS)[0]:
        j = where.get(OWNER[d])
        if j is not None and s[d] > pos[j]:
            pos[j] = s[d]
    for d in np.nonzero(IS_NEAR)[0]:
        j = where.get(OWNER[d])
        if j is not None and s[d] > neg[j]:
            neg[j] = s[d]
    return pos, neg, bg


def packet(f, theta, delta):
    pos, neg, bg = f
    margin = pos - np.maximum(neg, bg)
    keep = (pos >= theta) & (margin >= delta)
    order = [j for j in np.argsort(-pos, kind="stable") if keep[j]]
    return order[:KMAX]


def metrics(pk, ids):
    pos = [q for q in ids if C[q]["gold"]]; neg = [q for q in ids if not C[q]["gold"]]
    r = [len(set(C[q]["gold"]) & set(pk[q][:K])) / len(C[q]["gold"]) for q in pos]
    pr = [d in C[q]["gold"] for q in pos for d in pk[q][:K]]
    return dict(n_pos=len(pos), n_neg=len(neg), r4=round(float(np.mean(r)), 4) if r else None,
                fir=round(float(np.mean([bool(pk[q]) for q in neg])), 4) if neg else None,
                prec=round(float(np.mean(pr)), 4) if pr else None)


def ids_of(f):
    return [q for q in C if f(C[q])]


SETS = {
    "dev": ids_of(lambda c: c["split"] == "dev"),
    "test": ids_of(lambda c: c["split"] == "test"),
    "test_hand": ids_of(lambda c: c["split"] == "test" and c["author"] == "hand"),
    "test_qwen": ids_of(lambda c: c["split"] == "test" and c["author"] != "hand"),
    "nim_para": ids_of(lambda c: c["cat"] == "nim-para"),
    "nim_policy": ids_of(lambda c: c["cat"] == "nim-policy"),
    "nim_neg": ids_of(lambda c: c["cat"] == "nim-neg"),
}


def ids_packets(F, theta, delta, ids):
    return {q: [LIVE[VIS[q][j]]["id"] for j in packet(F[q], theta, delta)] for q in ids}


def tune(F, fir_max):
    pos_tops = sorted({round(float(F[q][0].max()), 3) for q in DEV if len(F[q][0])})
    thetas = [0.0] + list(np.quantile(pos_tops, np.linspace(0.02, 0.98, 30)))
    deltas = [-0.1, -0.05, 0.0, 0.02, 0.05, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3]
    best = None
    for theta, delta in itertools.product(thetas, deltas):
        m = metrics(ids_packets(F, theta, delta, DEV), DEV)
        if m["fir"] > fir_max:
            continue
        u = m["r4"] + 0.1 * (m["prec"] or 0)
        if best is None or u > best[0] + 1e-12:
            best = (u, float(theta), float(delta), m)
    return best


def evaluate(F, theta, delta):
    return {name: metrics(ids_packets(F, theta, delta, ids), ids) for name, ids in SETS.items()}


def ranking(F):
    """Ungated: recall@4 of the order alone (the gate's ceiling)."""
    out = {}
    for name, ids in SETS.items():
        pos = [q for q in ids if C[q]["gold"]]
        if pos:
            pk = {q: [LIVE[VIS[q][j]]["id"] for j in np.argsort(-F[q][0], kind="stable")[:K]] for q in pos}
            out[name] = metrics(pk, pos)["r4"]
    return out


if __name__ == "__main__":
    results = {"bank": args.bank, "ablation": {"no_near": args.no_near, "no_background": args.no_background,
                                               "needs": args.needs}, "runs": []}
    for mode, alpha in itertools.product(["prompt", "ctx"], [0.0, 0.3, 0.5, 0.7, 1.0]):
        F = {q: features(q, mode, alpha) for q in C}
        row = {"mode": mode, "alpha": alpha, "ranking": ranking(F)}
        for fir_max in (0.05, 0.0):
            t = tune(F, fir_max)
            if t is None:
                row[f"dev{fir_max}"] = None
                continue
            u, theta, delta, devm = t
            row[f"dev{fir_max}"] = {"theta": round(theta, 4), "delta": delta, "dev": devm}
        results["runs"].append(row)
        print(mode, alpha, "ranking", row["ranking"].get("dev"), "| dev5%", row["dev0.05"] and row["dev0.05"]["dev"],
              "| dev0%", row["dev0.0"] and row["dev0.0"]["dev"], flush=True)
    # The configuration is chosen on dev only (the best dev utility at the 5% cap), then scored once on every set.
    def util(r, cap):
        d = r.get(f"dev{cap}")
        return -1 if not d else d["dev"]["r4"] + 0.1 * (d["dev"]["prec"] or 0)
    for cap in (0.05, 0.0):
        best = max(results["runs"], key=lambda r: util(r, cap))
        F = {q: features(q, best["mode"], best["alpha"]) for q in C}
        g = best[f"dev{cap}"]
        results[f"chosen{cap}"] = {"mode": best["mode"], "alpha": best["alpha"], "theta": g["theta"], "delta": g["delta"],
                                   "eval": evaluate(F, g["theta"], g["delta"]), "ranking": best["ranking"]}
        print(f"\nCHOSEN at dev FIR <= {cap}:", best["mode"], best["alpha"], g["theta"], g["delta"])
        for name, m in results[f"chosen{cap}"]["eval"].items():
            print(f"  {name:11s} {m}")
    if args.out:
        json.dump(results, open(args.out, "w"), indent=1)
