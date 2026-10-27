"""E2: sleep-side aliases from strong hosted models.

(a) Blind doc2query: <= 8 aliases per row (gen_aliases_nim.py), raw and df-capped (A2 §2.3: every alias token df <= 6).
    Scored as R1 M3: BM25F(subject x2, text x1, aliases x1.5) + context, (i) at the R1-tuned BM25F_ctx gate and
    (ii) re-tuned on dev exactly like R1 M3 (eval.py calibrate).
(b) Miss-driven acceptance (D21 / A7 §6), simulated:
    - system S0 = BM25F_ctx at the R1-tuned gate; a miss = (training cue, gold row) with the gold row not in packet[:4];
    - proposals per miss: (lex) up to 3 content tokens of the cue with df <= 50, not already in the row, rarest first;
      (llm) up to 3 alias phrases from a NIM model given the memory + the missed cue, split into content tokens;
    - accept (row, token) only if >= 2 distinct misses propose it AND replaying the other training-split cues + the
      training-split negatives with the alias added gives <= 1 new false fire; <= 8 accepted aliases per row;
    - fold 1 trains on dev and is scored on test (harm only: disjoint memories) and on test_nim, split into cues whose
      gold memory is a dev memory (benefit) and a test memory (harm only). Fold 2 swaps dev and test (supplementary).
Usage: python e2.py [llm-model ...]   (CUES=fixture/cues-all.json)
"""
import json, os, sys, collections
import numpy as np
from lexpy import BM25F, toks, ctx_cue, STOP
from nim import chat, parse_json

CUES = json.load(open(os.environ.get("CUES", "fixture/cues-all.json")))
MEMS = json.load(open("fixture/memories.json"))
LIVE = [m for m in MEMS if not m["superseded_by"]]
IDX = {m["id"]: i for i, m in enumerate(LIVE)}
BYID = {m["id"]: m for m in MEMS}
TUNED = {fir: next(r for r in json.load(open(f"out/results-fir{fir}.json")) if r["name"] == "M1 BM25F_ctx")["params"] for fir in ("0.05", "0.0")}
K, KMAX = 4, 6
VIS = {c["id"]: [i for i, m in enumerate(LIVE) if m["scope"] in ("", c["scope"])] for c in CUES}
Q = {c["id"]: toks(ctx_cue(c["cue"], c["last_paths"], c["prev_turn"])) for c in CUES}
C = {c["id"]: c for c in CUES}


def build(aliases=None):
    docs = [dict(m, aliases=(aliases or {}).get(m["id"], [])) for m in LIVE]
    return BM25F(docs, aliases_w=1.5 if aliases is not None else None)


def packet(bm, qid, t, rel):
    vis = VIS[qid]; q = Q[qid]
    s = np.array([bm.score(q, i) for i in vis])
    keep = s >= t
    if keep.any() and rel:
        top = s[keep].max(); keep &= s >= top * rel
    order = [j for j in np.argsort(-s, kind="stable") if keep[j]]
    return [LIVE[vis[j]]["id"] for j in order[:KMAX]]


def metrics(pk, ids):
    pos = [q for q in ids if C[q]["gold"]]; neg = [q for q in ids if not C[q]["gold"]]
    r = [len(set(C[q]["gold"]) & set(pk[q][:K])) / len(C[q]["gold"]) for q in pos]
    pr = [d in C[q]["gold"] for q in pos for d in pk[q][:K]]
    return dict(n_pos=len(pos), n_neg=len(neg), r4=float(np.mean(r)) if r else None, fir=float(np.mean([bool(pk[q]) for q in neg])) if neg else None,
                prec=float(np.mean(pr)) if pr else None)


def run_all(bm, t, rel):
    return {q: packet(bm, q, t, rel) for q in C}


def eval_sets(pk):
    ids = lambda f: [q for q in C if f(C[q])]
    return {
        "dev": metrics(pk, ids(lambda c: c["split"] == "dev")),
        "test": metrics(pk, ids(lambda c: c["split"] == "test")),
        "test_nim_pos": metrics(pk, ids(lambda c: c["split"] == "test_nim" and c["gold"])),
        "test_nim_devmem": metrics(pk, ids(lambda c: c["split"] == "test_nim" and c["gold"] and c.get("gold_orig_split") == "dev")),
        "test_nim_testmem": metrics(pk, ids(lambda c: c["split"] == "test_nim" and c["gold"] and c.get("gold_orig_split") == "test")),
        "test_nim_neg": metrics(pk, ids(lambda c: c["split"] == "test_nim" and not c["gold"])),
        "test_nim_policy": metrics(pk, ids(lambda c: c["cat"] == "nim-policy")),
    }


# ---------------- (a) blind doc2query ----------------
def df_cap(aliases, cap=6):
    bmA = build(aliases)
    return {k: [a for a in v if all(bmA.df.get(t, 0) <= cap for t in toks(a))] for k, v in aliases.items()}


# ---------------- (b) miss-driven ----------------
LLM_PROMPT = ("A coding agent keeps notes about a repository. The developer sent this message and needed the note below, but the "
              "note's keyword search missed it because they share no words.\nMessage: \"{cue}\"\nNote: \"{note}\"\n\n"
              "Propose up to 3 short alias keywords (1-2 words each) to attach to the note so that similar future messages find it. "
              "Prefer words from the message that generalize to other phrasings of the same need; never generic words (fix, error, code, "
              "help, issue, problem, file). Return JSON only: {{\"aliases\": [strings]}}")


def llm_proposals(model, cue, mem):
    txt, rec = chat(model, [{"role": "user", "content": LLM_PROMPT.format(cue=cue, note=f"{mem['subject']}: {mem['text']}")}], tag="e2-miss",
                    temperature=0.0, max_tokens=2048, extra={"chat_template_kwargs": {"enable_thinking": False}} if "nemotron" in model else None)
    js = parse_json(txt)
    al = js.get("aliases", []) if isinstance(js, dict) else []
    return [str(a).lower() for a in al][:3]


def miss_driven(train_split, proposer, t, rel, llm_model=None, log=None):
    bm0 = build({})
    df0 = bm0.df
    train = [q for q in C if C[q]["split"] == train_split]
    pk0 = {q: packet(bm0, q, t, rel) for q in train}
    misses = [(q, g) for q in train if C[q]["gold"] for g in C[q]["gold"] if g not in pk0[q][:K]]
    props = collections.defaultdict(set)  # (row, token) -> set of proposing cue ids
    for q, g in misses:
        row_toks = set(toks(f"{BYID[g]['subject']} {BYID[g]['text']}"))
        if proposer == "lex":
            cand = [x for x in dict.fromkeys(toks(C[q]["cue"])) if x not in STOP and df0.get(x, 0) <= 50 and x not in row_toks and x.isalnum()]
            cand = sorted(cand, key=lambda x: df0.get(x, 0))[:3]
        else:
            cand = []
            for a in llm_proposals(llm_model, C[q]["cue"], BYID[g]):
                cand += [x for x in toks(a) if x.isalnum() and x not in row_toks and x not in STOP]
            cand = list(dict.fromkeys(cand))
        for x in cand:
            props[(g, x)].add(q)
    supported = {k: v for k, v in props.items() if len(v) >= 2}
    accepted = collections.defaultdict(list); rejected = []
    base_neg_fire = {q: bool(pk0[q]) for q in train if not C[q]["gold"]}
    for (g, x), srcs in sorted(supported.items(), key=lambda kv: -len(kv[1])):
        if len(accepted[g]) >= 8:
            continue
        trial = {k: list(v) for k, v in accepted.items()}; trial.setdefault(g, []).append(x)
        bm = build(trial)
        new_false = 0
        for q in train:
            if q in srcs:
                continue
            p = packet(bm, q, t, rel)
            if not C[q]["gold"]:
                new_false += (bool(p) and not base_neg_fire[q]) or (g in p and g not in pk0[q])
            elif g in p and g not in C[q]["gold"] and g not in pk0[q]:
                new_false += 1
            if new_false > 1:
                break
        if new_false <= 1:
            accepted[g].append(x)
        else:
            rejected.append((g, x, len(srcs), new_false))
    stats = dict(train=train_split, proposer=proposer if proposer == "lex" else llm_model, misses=len(misses), proposals=len(props),
                 supported_ge2=len(supported), accepted=sum(map(len, accepted.values())), rows_with_alias=len(accepted),
                 rejected_by_replay=len(rejected), accepted_list={k: v for k, v in accepted.items()})
    return dict(accepted), stats


def prefetch(llms):
    """Issue every LLM miss proposal up front, in parallel (results land in the disk cache)."""
    from concurrent.futures import ThreadPoolExecutor
    bm0 = build({}); pairs = set()
    for split in ("dev", "test"):
        for p in TUNED.values():
            for q in C:
                if C[q]["split"] == split and C[q]["gold"]:
                    pk = packet(bm0, q, p["t"], p.get("rel", 0))
                    pairs |= {(q, g) for g in C[q]["gold"] if g not in pk[:K]}
    jobs = [(m, q, g) for m in llms for q, g in sorted(pairs)]
    def one(j):
        try:
            llm_proposals(j[0], C[j[1]]["cue"], BYID[j[2]])
        except Exception as ex:
            print("prefetch error", j, str(ex)[:100], flush=True)
    with ThreadPoolExecutor(int(os.environ.get("NT", "8"))) as ex:
        list(ex.map(one, jobs))
    print("prefetched", len(jobs), "miss proposals", flush=True)


def main():
    llms = sys.argv[1:] or ["google/gemma-4-31b-it"]
    prefetch(llms)
    out = {"baseline": {}, "blind": {}, "miss": {}}
    base = build({})
    for fir, p in TUNED.items():
        out["baseline"][fir] = eval_sets(run_all(base, p["t"], p.get("rel", 0)))
        print("baseline", fir, {k: {kk: round(vv, 3) if isinstance(vv, float) else vv for kk, vv in v.items()} for k, v in out["baseline"][fir].items()}, flush=True)
    # (a) blind
    for name, path in [("phi35(R1)", "fixture/aliases.json"), ("gemma-4-31b", "fixture/aliases-gemma.json"), ("nemotron-3-super", "fixture/aliases-nemosuper.json")]:
        if not os.path.exists(path):
            continue
        al = json.load(open(path)); al = {k: v for k, v in al.items() if k in IDX}
        for variant, a in [("raw", al), ("capped", df_cap(al))]:
            bm = build(a)
            for fir, p in TUNED.items():
                res = eval_sets(run_all(bm, p["t"], p.get("rel", 0)))
                out["blind"][f"{name}|{variant}|fixed-gate|{fir}"] = dict(n_alias=sum(map(len, a.values())), **res)
                print("blind", name, variant, fir, "test", res["test"], "nim", res["test_nim_pos"]["r4"], res["test_nim_neg"]["fir"], flush=True)
            json.dump(a, open(f"out/e2-aliases-{name.split('(')[0]}-{variant}.json", "w"))
    # (b) miss-driven, two folds
    for train, fold in [("dev", 1), ("test", 2)]:
        for proposer in ["lex"] + ["llm:" + m for m in llms]:
            for fir, p in TUNED.items():
                acc, st = miss_driven(train, "lex" if proposer == "lex" else "llm", p["t"], p.get("rel", 0), llm_model=None if proposer == "lex" else proposer[4:])
                res = eval_sets(run_all(build(acc), p["t"], p.get("rel", 0)))
                out["miss"][f"fold{fold}|{proposer}|{fir}"] = dict(stats=st, **res)
                print("miss", fold, proposer, fir, {k: v for k, v in st.items() if k != "accepted_list"}, "test", res["test"], "nimdev", res["test_nim_devmem"], "nimtest", res["test_nim_testmem"], flush=True)
    json.dump(out, open("out/e2-results.json", "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
