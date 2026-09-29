# Evaluator: calibrate each method on DEV (max utility s.t. dev false-inject rate <= FIR_MAX), report on TEST with bootstrap CIs.
import json, itertools, sys, math
import numpy as np
FIR_MAX = float(sys.argv[1]) if len(sys.argv) > 1 else 0.05
K = 4; KMAX = 6
rng = np.random.default_rng(0)
import os
SFX = os.environ.get("OUT_SFX", "")
cues = json.load(open(os.environ.get("CUES", "fixture/cues.json"))); mems = {m["id"]: m for m in json.load(open("fixture/memories.json"))}
ft = json.load(open(f"out/features-ts{SFX}.json")); fp = json.load(open(f"out/features-py{SFX}.json")); m0 = json.load(open(f"out/m0{SFX}.json"))
def rrf(*arrs):
    out = np.zeros_like(arrs[0])
    for a in arrs:
        r = np.empty(len(a)); r[np.argsort(-a)] = np.arange(len(a)); out += 1.0 / (60 + r)
    return out
C = {}
for c in cues:
    a, b = ft[c["id"]], fp[c["id"]]
    assert a["docs"] == b["docs"]
    f = {k: np.array(v, dtype=float) for k, v in {**a["f"], **b["f"]}.items()}
    C[c["id"]] = dict(c=c, docs=a["docs"], f=f, gold=set(c["gold"]))
for q in C.values():
    f = q["f"]
    for sfx in ["", "_ctx"]:
        r = rrf(f["bm25" + sfx], f["cos_bge" + sfx]); cand = np.zeros(len(r), bool); cand[np.argsort(-r)[:20]] = True
        f["cer" + sfx] = np.where(cand, f["ce" + sfx], -1e9)
POS = lambda c: bool(c["gold"])
CATS = ["lex", "para", "natural", "ctx", "indirect", "policy"]; NEGCATS = ["neg-chat", "neg-math", "neg-offtopic", "neg-hard"]

def z(x): return x
# ---------- method definitions: each returns (rank_score, list_of_(feature, threshold_param_name)), mode union ----------

def packet(q, m, p):
    f = q["f"]; s = m["rank"](f)
    keep = m["keep"](f, p) if "keep" in m else np.zeros(len(s), bool)
    for feat, key in m.get("gates", []):
        keep |= f[feat] >= p[key]
    if "and" in m:
        for feat, key in m["and"]: keep &= f[feat] >= p[key]
    if "rel" in p and keep.any():
        top = s[keep].max(); keep &= s >= top * p["rel"] if top > 0 else keep
    if "margin" in p and keep.any():
        top = s[keep].max(); keep &= s >= top - p["margin"]
    idx = [i for i in np.argsort(-s, kind="stable") if keep[i]]
    return [q["docs"][i] for i in idx[:KMAX]]

def metrics(ids, packets):
    rec4, rec6, prec_s, prec_l, nb, fir = {}, {}, [], [], [], {}
    for qid in ids:
        q = C[qid]; pk = packets[qid]; g = q["gold"]
        if g:
            p4 = pk[:K]
            rec4[qid] = len(g & set(p4)) / len(g); rec6[qid] = len(g & set(pk[:KMAX])) / len(g)
            gsub = {mems[x]["subject"] for x in g}
            for d in p4: prec_s.append(d in g); prec_l.append(d in g or mems[d]["subject"] in gsub)
            nb.append(len(p4))
        else:
            fir[qid] = 1.0 if pk else 0.0
    return rec4, rec6, prec_s, prec_l, nb, fir

def summary(ids, packets):
    rec4, rec6, ps, pl, nb, fir = metrics(ids, packets)
    return dict(r4=np.mean(list(rec4.values())), r6=np.mean(list(rec6.values())), fir=np.mean(list(fir.values())), ps=np.mean(ps) if ps else float("nan"), pl=np.mean(pl) if pl else float("nan"), nb=np.mean(nb))

UW = float(__import__("os").environ.get("PREC_W", "0.1"))
def utility(s): return s["r4"] + UW * (0 if math.isnan(s["ps"]) else s["ps"])

DEV = [c["id"] for c in cues if c["split"] == "dev"]; TEST = [c["id"] for c in cues if c["split"] == "test"]
def qgrid(feat, ids, n=40):
    tops = [C[q]["f"][feat].max() for q in ids]
    vals = np.unique(np.quantile(tops, np.linspace(0.02, 0.99, n)))
    return list(vals) + [float("inf")]

def calibrate(m):
    if "grid" in m:
        best = None; g = m["grid"](DEV) if callable(m["grid"]) else m["grid"]
        for combo in itertools.product(*g.values()):
            p = dict(zip(g.keys(), combo)); pk = {q: packet(C[q], m, p) for q in DEV}; s = summary(DEV, pk)
            if s["fir"] > FIR_MAX: continue
            u = utility(s)
            if best is None or u > best[0] + 1e-12: best = (u, p, s)
        return best
    keys = [k for _, k in m["gates"]] + [k for _, k in m.get("and", [])]
    feats = [f for f, _ in m["gates"]] + [f for f, _ in m.get("and", [])]
    grids = [qgrid(f, DEV, 30 if len(keys) > 1 else 60) for f in feats]
    extra = m.get("extra", {})
    best = None
    for combo in itertools.product(*grids, *extra.values()):
        p = dict(zip(keys + list(extra.keys()), combo))
        if all(math.isinf(p[k]) for k in keys[:len(m["gates"])]): continue
        pk = {q: packet(C[q], m, p) for q in DEV}
        s = summary(DEV, pk)
        if s["fir"] > FIR_MAX: continue
        u = utility(s)
        if best is None or u > best[0] + 1e-12: best = (u, p, s)
    return best

def boot(ids, packets, B=2000):
    rec4, rec6, ps, pl, nb, fir = metrics(ids, packets)
    r = np.array(list(rec4.values())); f = np.array(list(fir.values()))
    br = [r[rng.integers(0, len(r), len(r))].mean() for _ in range(B)]; bf = [f[rng.integers(0, len(f), len(f))].mean() for _ in range(B)]
    return (np.percentile(br, 2.5), np.percentile(br, 97.5)), (np.percentile(bf, 2.5), np.percentile(bf, 97.5))

def evidence(sfx, dense, strict=False):
    # R2 §7.4 evidence-typed gate: STRONG = matched token df<=S; MEDIUM = matched token df<=M.
    # admit on 1 STRONG, or 2 MEDIUM, or 1 MEDIUM + dense cos>=td (independent source), or dense-only top-1 with cos>=th AND top1-top2 gap>=g (shape abstention)
    cf = f"cos_{dense}{sfx}"
    def keep(f, p):
        c = f[cf]; srt = np.sort(c)[::-1]; gap = srt[0] - srt[1] if len(srt) > 1 else 1.0
        nM = f[f"n{p['M']}{sfx}"]
        k = (f["mindf" + sfx] <= p["S"]) | (nM >= p["need"]) | ((nM >= 1) & (c >= p["td"]))
        k = k & (f["bm25" + sfx] >= p["t"])  # lexical admissions also need a BM25F floor (t=0: pure R2 rule)
        if gap >= p["g"]: k = k | ((c >= p["th"]) & (c == srt[0]))
        return k
    def grid(ids):
        tops = [C[q]["f"][cf].max() for q in ids]
        bt = [C[q]["f"]["bm25" + sfx].max() for q in ids]
        return {"S": [0, 1, 2, 3], "M": [10, 25, 50], "need": [2, 3], "td": list(np.quantile(tops, np.linspace(0.3, 0.95, 6))), "th": [9.0] + list(np.quantile(tops, [0.9, 0.97])), "g": [0.03, 0.08],
                "t": ([0.0] if strict else [0.0] + list(np.quantile(bt, [0.3, 0.45, 0.6, 0.7, 0.8])))}
    return dict(rank=lambda f: rrf(f["bm25" + sfx], f[cf]), keep=keep, grid=grid)

REL = {"rel": [0.0, 0.5, 0.7]}; MAR = {"margin": [9.0, 0.08, 0.04]}
def single(feat, extra): return dict(rank=lambda f, k=feat: f[k], gates=[(feat, "t")], extra=extra)
def M(sfx=""):
    b, ba = "bm25" + sfx, "bm25a" + sfx
    return {
        f"M1 BM25F{sfx}": single(b, REL),
        f"M1r BM25F+rare-gate{sfx}": dict(rank=lambda f: f[b], gates=[(b, "t")], **{"and": [("maxidf" + sfx, "rare")]}, extra=REL),
        f"M2 BM25+trigram{sfx}": dict(rank=lambda f: f[b] + 4 * f["tri" + sfx], gates=[(b, "t"), ("tri" + sfx, "tt")], extra={}),
        f"M3 BM25F+aliases{sfx}": single(ba, REL),
        f"M3c BM25F+aliases(df-capped){sfx}": single("bm25c" + sfx, REL),
        f"M6 BM25F+alc|r32 union RRF{sfx}": dict(rank=lambda f: rrf(f["bm25c" + sfx], f["cos_r32" + sfx]), gates=[("bm25c" + sfx, "t"), ("cos_r32" + sfx, "td")], extra={}),
        f"M4 potion-base-8M{sfx}": single("cos_b8" + sfx, MAR),
        f"M4 potion-retrieval-32M{sfx}": single("cos_r32" + sfx, MAR),
        f"M4a potion-r32+aliases{sfx}": single("cosa_r32" + sfx, MAR),
        f"M5 bge-small{sfx}": single("cos_bge" + sfx, MAR),
        f"M5 MiniLM-L6{sfx}": single("cos_mini" + sfx, MAR),
        f"M6 BM25F|r32 union RRF{sfx}": dict(rank=lambda f: rrf(f[b], f["cos_r32" + sfx]), gates=[(b, "t"), ("cos_r32" + sfx, "td")], extra={}),
        f"M6 BM25F+al|r32 union RRF{sfx}": dict(rank=lambda f: rrf(f[ba], f["cos_r32" + sfx]), gates=[(ba, "t"), ("cos_r32" + sfx, "td")], extra={}),
        f"M6 BM25F|bge union RRF{sfx}": dict(rank=lambda f: rrf(f[b], f["cos_bge" + sfx]), gates=[(b, "t"), ("cos_bge" + sfx, "td")], extra={}),
        f"M6 BM25F+al|bge union RRF{sfx}": dict(rank=lambda f: rrf(f[ba], f["cos_bge" + sfx]), gates=[(ba, "t"), ("cos_bge" + sfx, "td")], extra={}),
        f"M9s evidence-gate pure R2 rule BM25F+r32{sfx}": evidence(sfx, "r32", True),
        f"M9 evidence-gate BM25F+r32{sfx}": evidence(sfx, "r32"),
        f"M9 evidence-gate BM25F+bge{sfx}": evidence(sfx, "bge"),
        f"M8 cross-encoder (all visible){sfx}": single("ce" + sfx, {}),
        f"M8 RRF(BM25F,bge) top20 -> CE rerank{sfx}": single("cer" + sfx, {}),
    }

def main():
    methods = {**M(""), **M("_ctx")}
    rows = []; test_packets = {}
    # fixed (uncalibrated) M0 variants
    for name in ["M0", "M0_paths", "M0_ctx"]:
        pk = {q: m0[q][name] for q in C}
        rows.append((name + " (Eden today)", None, summary(DEV, pk), summary(TEST, pk), boot(TEST, pk), pk))
    for name, m in methods.items():
        best = calibrate(m)
        if best is None:
            global FIR_MAX
            save = FIR_MAX; FIR_MAX = 1.0; b2 = calibrate(m); FIR_MAX = save
            print("no feasible point", name, "| unconstrained best: dev", {k: round(float(v), 3) for k, v in b2[2].items()}, b2[1]); continue
        u, p, sdev = best
        pk = {q: packet(C[q], m, p) for q in C}
        rows.append((name, p, sdev, summary(TEST, pk), boot(TEST, pk), pk))
        print(f"{name:42s} dev r4={sdev['r4']:.3f} fir={sdev['fir']:.3f} | test r4={rows[-1][3]['r4']:.3f} fir={rows[-1][3]['fir']:.3f} ps={rows[-1][3]['ps']:.3f} p={ {k: round(v, 3) for k, v in p.items()} }", flush=True)
    json.dump([dict(name=r[0], params=r[1], dev=r[2], test=r[3], ci_r4=r[4][0], ci_fir=r[4][1], packets={q: r[5][q] for q in TEST}) for r in rows], open(f"out/results-fir{FIR_MAX}.json", "w"), default=float)
    # per-category table on TEST
    print("\nTEST per-category recall@4 / @6, silence by neg category")
    hdr = "method | " + " | ".join(f"{c} r@4" for c in CATS) + " | all-pos r@4 [95% CI] | all-pos r@6 | " + " | ".join(f"{c} sil" for c in NEGCATS) + " | silence [FIR 95% CI] | prec strict | prec lenient | bullets/pos"
    print(hdr)
    for name, p, sdev, st, (cir, cif), pk in rows:
        cat = lambda k: [q for q in TEST if C[q]["c"]["cat"] == k]
        vals = []
        for k in CATS:
            r4, *_ = metrics(cat(k), pk); vals.append(f"{np.mean(list(r4.values())):.2f}")
        negs = []
        for k in NEGCATS:
            *_, fir = metrics(cat(k), pk); negs.append(f"{1 - np.mean(list(fir.values())):.2f}")
        print(f"{name} | " + " | ".join(vals) + f" | {st['r4']:.3f} [{cir[0]:.2f},{cir[1]:.2f}] | {st['r6']:.3f} | " + " | ".join(negs) + f" | {1 - st['fir']:.3f} [FIR {cif[0]:.2f},{cif[1]:.2f}] | {st['ps']:.2f} | {st['pl']:.2f} | {st['nb']:.2f}")

if __name__ == "__main__" and len(sys.argv) <= 2:
    main()

def overlap_table(path):
    ov = json.load(open("out/overlap.json")); res = json.load(open(path))
    print("\nTEST recall@4 by lexical-overlap class of cue vs gold (none = shares no content token with any gold row)")
    classes = ["none", "common", "rare"]
    cats = CATS
    print("method | " + " | ".join(f"{k} (n={sum(1 for q in TEST if ov.get(q)==k)})" for k in classes) + " | none by cat: " + ", ".join(cats))
    for r in res:
        pk = r["packets"]; row = []
        for k in classes:
            ids = [q for q in TEST if ov.get(q) == k]
            row.append(f"{np.mean([len(C[q]['gold'] & set(pk[q][:K])) / len(C[q]['gold']) for q in ids]):.2f}")
        bycat = []
        for c in cats:
            ids = [q for q in TEST if ov.get(q) == "none" and C[q]["c"]["cat"] == c]
            bycat.append(f"{c}:{np.mean([len(C[q]['gold'] & set(pk[q][:K])) / len(C[q]['gold']) for q in ids]):.2f}(n={len(ids)})" if ids else f"{c}:-")
        print(f"{r['name']} | " + " | ".join(row) + " | " + ", ".join(bycat))

if __name__ == "__main__" and len(sys.argv) > 2:
    overlap_table(sys.argv[2])
