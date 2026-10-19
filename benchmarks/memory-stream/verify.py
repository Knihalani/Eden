"""F22 deferred in-turn verification: Eden still decides unasked, with understanding, and the hook stays model-free.

At UserPromptSubmit the hook picks `n` candidate rows with its fast matchers (no model) and returns nothing. A small
fast model then checks the candidates outside the hook (a warm sidecar or the sleep process), which takes seconds.
The verified packet is delivered at the turn's first PreToolUse or PostToolBatch, while the agent works. A turn
with no tool call gets no packet (the delivery point never comes); score.py's `verify` system applies that rule.

    python3 benchmarks/memory-stream/verify.py prep --world code [--n 15]
    score.py --world code --store sleep --strict --sample judge --systems "verify"            (deferred, honest)
    score.py --world code --store sleep --strict --sample judge --systems "verify:ideal=1"    (as if at Submit)
    verify.py prep --world code --per 1 --tag seq; score.py ... --systems "verify:tag=seq"    (leak-free re-run)

The verifier is haiku, a different model family from the authors (opus/default) and the labeler (sonnet). It sees
the turn, the recent context and the candidates only, never the labels.
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def prep(world, n, per, tag="", fresh=False, contrast=0):
    import score, sleep, methods, judge
    stream, items = score.load_stream(world)
    cov = score.Coverage(items)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    rows = sleep.rows(stream, world, strict=True)
    lex = methods.make("lex:when=1", rows, stream, items, cov)
    bank = methods.make("bank:tau=0.0,when=1", rows, stream, items, cov)
    ids = []
    for p in sorted(glob.glob(os.path.join(HERE, "judge", f"{world}-sleep", "in", "*.json"))):
        ids += [c["event"] for c in json.load(open(p))["cases"]]
    if fresh:  # red-team worlds: every fresh human and trigger event
        ids = [i for i, e in evs.items() if e["_split"] == "fresh" and e["t"] in ("human", "trigger")]
    sub = f"{world}-{tag}" if tag else world
    d = os.path.join(HERE, "verify", sub)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases = []
    ids.sort(key=lambda i: evs[i]["_order"])
    human = sorted((x for x in score.scored_events(stream) if x["t"] == "human"), key=lambda x: x["_order"])
    for eid in ids:
        e = evs[eid]
        q = dict(e, text_all=methods.strip_paste(e["text_all"]))
        a = lex.scores(q, e["_order"])
        b = bank.scores(q, e["_order"])
        top = sorted(a, key=lambda i: (-a[i], i))[: n // 2] + sorted(b, key=lambda i: (-b[i], i))[:n]
        cand = list(dict.fromkeys(top))[:n]
        case = {"event": eid, "type": e["t"], "text": e["text_all"][:2000], "recent": judge.context(stream, eid, 4),
                "candidates": [{"id": i, "text": lex.by_id[i]["text"]} for i in cand]}
        if contrast:  # causal calibration: the user's own human turns from earlier sessions (C4-E11)
            sess = e["session"]
            past = [x for x in human if x["_order"] < e["_order"] and x["session"] != sess]
            case["earlier_turns"] = [methods.strip_paste(x["text_all"])[:300] for x in past[-contrast:]]
        cases.append(case)
    for b in range(0, len(cases), per):
        name = f"v{b // per:03d}" if per < 10 else f"v{b // per:02d}"
        json.dump({"batch": name, "cases": cases[b:b + per], "output": f"benchmarks/memory-stream/verify/{sub}/out/{name}.json"},
                  open(os.path.join(d, "in", f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(cases[b:b + per]))
    hit = 0
    tot = 0
    for c in cases:
        e = evs[c["event"]]
        need = set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))
        if need:
            tot += 1
            covered = set().union(*[lex.by_id[x["id"]]["covers"] for x in c["candidates"]]) if c["candidates"] else set()
            hit += len(need & covered) / len(need)
    print("candidate recall ceiling (plan labels):", round(hit / max(1, tot), 4), "over", tot, "need events")


def picks(world, tag=""):
    out = {}
    for p in glob.glob(os.path.join(HERE, "verify", f"{world}-{tag}" if tag else world, "out", "*.json")):
        for c in json.load(open(p))["cases"]:
            if "scores" in c:  # calibrated output: {row id: p}; filtered by threshold in score.py
                out[c["event"]] = sorted(c["scores"].items(), key=lambda kv: (-kv[1], kv[0]))
            else:
                out[c["event"]] = c.get("needed", [])
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("--per", type=int, default=50)
    ap.add_argument("--fresh", action="store_true", help="red-team worlds: all fresh-split human and trigger events")
    ap.add_argument("--contrast", type=int, default=0, help="add the user's last N human turns from earlier sessions")
    ap.add_argument("--tag", default="", help="writes verify/<world>-<tag>/ (e.g. seq: one case per file, stream order)")
    a = ap.parse_args()
    prep(a.world, a.n, a.per, a.tag, a.fresh, a.contrast)
