"""Critic C4 direction B: the draft check. Eden reviews the agent's draft answer before the user sees it.

When the agent stops (Claude Code's Stop hook), a small model sees the turn, the recent context, the agent's draft
and Eden's candidate rows (F22's shortlist: lex+when top n/2 ∪ bank top n, no model). It blocks only when the draft
contradicts a row, or misses one the user would expect it to know. The block carries a short memory note and the
agent revises. Eden still decides, unasked, and a turn with no tool call is covered too (every turn stops).

Turns and drafts are C3-E4's downstream sample: the draft is the `none` response (written with no memory).

    python3 benchmarks/memory-stream/draftcheck.py prep --world code            # checker inputs, one file per case
    python3 benchmarks/memory-stream/draftcheck.py fires --world code           # fire rate and need recall
    python3 benchmarks/memory-stream/draftcheck.py revise-prep --world code     # responder revises blocked drafts
    python3 benchmarks/memory-stream/draftcheck.py judge-prep --world code      # blind judge: none / oracle / revised
    python3 benchmarks/memory-stream/draftcheck.py report --world code

The checker gets one case per file, in stream order, and sees nothing after its turn.
"""
import argparse, glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _dir(world, *p):
    return os.path.join(HERE, "draftcheck", world, *p)


def _down(world):
    """The C3-E4 responses the draft check was run on (archived in downstream/old-c3 when C4-E10 re-ran them)."""
    d = os.path.join(HERE, "downstream", world)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    rp = os.path.join(HERE, "downstream", "old-c3", world, "responses.json")
    if not os.path.exists(rp):
        rp = os.path.join(d, "out", "responses.json")
    resp = {c["event"]: c["responses"] for c in json.load(open(rp))["cases"]}
    src = {c["event"]: c for c in json.load(open(os.path.join(d, "in", "responses-in.json")))["cases"]}
    return key, resp, src


def _response(key, resp, eid, cond):
    return resp[eid][key[eid]["order"].index(cond)]


def prep(a):
    import score, sleep, methods
    stream, items = score.load_stream(a.world)
    cov = score.Coverage(items)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    rows = sleep.rows(stream, a.world, strict=True)
    lex = methods.make("lex:when=1", rows, stream, items, cov)
    bank = methods.make("bank:tau=0.0,when=1", rows, stream, items, cov)
    key, resp, src = _down(a.world)
    os.makedirs(_dir(a.world, "in"), exist_ok=True)
    os.makedirs(_dir(a.world, "out"), exist_ok=True)
    for n, eid in enumerate(sorted(key, key=lambda i: evs[i]["_order"])):
        e = evs[eid]
        q = dict(e, text_all=methods.strip_paste(e["text_all"]))
        sa, sb = lex.scores(q, e["_order"]), bank.scores(q, e["_order"])
        top = sorted(sa, key=lambda i: (-sa[i], i))[: a.n // 2] + sorted(sb, key=lambda i: (-sb[i], i))[: a.n]
        cand = list(dict.fromkeys(top))[: a.n]
        name = f"c{n:02d}"
        json.dump({"event": eid, "text": src[eid]["text"], "recent": src[eid]["recent"],
                   "draft": _response(key, resp, eid, "none"),
                   "candidates": [{"id": i, "text": lex.by_id[i]["text"]} for i in cand],
                   "output": f"benchmarks/memory-stream/draftcheck/{a.world}/out/{name}.json"},
                  open(_dir(a.world, "in", f"{name}.json"), "w"), indent=1, ensure_ascii=False)
    print(len(key), "cases")


def _checks(world):
    out = {}
    for p in glob.glob(_dir(world, "out", "c*.json")):
        c = json.load(open(p))
        out[c["event"]] = c
    return out


def fires(a):
    import score, sleep, methods
    stream, items = score.load_stream(a.world)
    cov = score.Coverage(items)
    rows = methods.make("lex", sleep.rows(stream, a.world, strict=True), stream, items, cov).by_id
    key, _, _ = _down(a.world)
    chk = _checks(a.world)
    by = {}
    for eid, k in key.items():
        if eid not in chk:
            continue
        c = chk[eid]
        g = by.setdefault(k["group"], {"n": 0, "fired": 0, "need_hit": 0.0, "need_n": 0})
        g["n"] += 1
        g["fired"] += bool(c.get("block"))
        need = set(k["needs"])
        if need:
            got = set().union(*[rows[r]["covers"] for r in c.get("rows", []) if r in rows]) if c.get("block") else set()
            g["need_n"] += 1
            g["need_hit"] += len(need & got) / len(need)
    for g, v in by.items():
        print(g, {"n": v["n"], "fire rate": round(v["fired"] / v["n"], 4),
                  "need recall": round(v["need_hit"] / v["need_n"], 4) if v["need_n"] else None})


def revise_prep(a):
    key, resp, src = _down(a.world)
    chk = _checks(a.world)
    cases = []
    for eid, c in sorted(chk.items()):
        if c.get("block"):
            cases.append({"event": eid, "text": src[eid]["text"], "recent": src[eid]["recent"],
                          "draft": _response(key, resp, eid, "none"), "note": c.get("note", ""),
                          "rows": [x["text"] for x in json.load(open(_dir(a.world, "in", _infile(a.world, eid))))
                                   ["candidates"] if x["id"] in c.get("rows", [])]})
    json.dump({"cases": cases, "output": f"benchmarks/memory-stream/draftcheck/{a.world}/out/revised.json"},
              open(_dir(a.world, "in", "revise-in.json"), "w"), indent=1, ensure_ascii=False)
    print(len(cases), "blocked drafts to revise")


def _infile(world, eid):
    for p in glob.glob(_dir(world, "in", "c*.json")):
        if json.load(open(p))["event"] == eid:
            return os.path.basename(p)


def _final(world):
    key, resp, _ = _down(world)
    rev = {}
    p = _dir(world, "out", "revised.json")
    if os.path.exists(p):
        rev = {c["event"]: c["response"] for c in json.load(open(p))["cases"]}
    return {eid: rev.get(eid, _response(key, resp, eid, "none")) for eid in key}


def judge_prep(a):
    import score
    from evidence import History
    stream, items = score.load_stream(a.world)
    hist = History(stream)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    key, resp, src = _down(a.world)
    fin = _final(a.world)
    rev = {c["event"] for c in json.load(open(_dir(a.world, "out", "revised.json")))["cases"]}
    rng = random.Random(11)
    cases, jkey = [], {}
    for eid in sorted(key):
        if eid not in rev:
            continue
        e = evs[eid]
        conds = {"none": _response(key, resp, eid, "none"), "oracle": _response(key, resp, eid, "oracle"),
                 "revised": fin[eid]}
        order = list(conds)
        rng.shuffle(order)
        jkey[eid] = order
        facts = [items[i]["text"] for i, t in sorted(e["_stated"].items(), key=lambda kv: kv[1])
                 if not (items[i].get("superseded_by") in e["_stated"])]
        base = src[eid]["text"] + " " + " ".join(x["text"] for x in src[eid]["recent"])
        resps = [conds[c] for c in order]
        cases.append({"event": eid, "text": src[eid]["text"], "recent": src[eid]["recent"], "reference_facts": facts,
                      "history_evidence": hist.evidence(eid, base, resps), "responses": resps})
    json.dump({"cases": cases, "output": f"benchmarks/memory-stream/draftcheck/{a.world}/out/judged.json"},
              open(_dir(a.world, "in", "judge-in.json"), "w"), indent=1, ensure_ascii=False)
    json.dump(jkey, open(_dir(a.world, "judge-key.json"), "w"), indent=1)
    print(len(cases), "revised turns for the judge")


def report(a):
    key, _, _ = _down(a.world)
    jkey = json.load(open(_dir(a.world, "judge-key.json")))
    judged = {}
    for p in glob.glob(_dir(a.world, "out", "judged*.json")):
        judged.update({c["event"]: c["scores"] for c in json.load(open(p))["cases"]})
    by = {}
    for eid, k in key.items():
        g = by.setdefault(k["group"], {"n": 0, "rev": 0.0, "orc": 0.0, "fired": 0})
        g["n"] += 1
        if eid in judged:
            s = dict(zip(jkey[eid], judged[eid]))
            g["fired"] += 1
            g["rev"] += s["revised"] - s["none"]
            g["orc"] += s["oracle"] - s["none"]
    for g, v in by.items():
        print(g, {"n": v["n"], "blocked": v["fired"], "mean revised−none (all turns)": round(v["rev"] / v["n"], 3),
                  "mean oracle−none (blocked turns)": round(v["orc"] / max(1, v["fired"]), 3)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep", "fires", "revise-prep", "judge-prep", "report"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--n", type=int, default=15)
    a = ap.parse_args()
    {"prep": prep, "fires": fires, "revise-prep": revise_prep, "judge-prep": judge_prep, "report": report}[a.cmd](a)
