"""Downstream effect (BRIEF §4.7): does the packet change the outcome?

For a sample of turns, a responder writes the agent's next reply (and the action it would take) under conditions:
  none     no memory
  oracle   the needed items (plan ∪ labeler) as a packet; empty on turns labelled no-need
  system   a candidate's packet (e.g. vote, pull)
Responses are shuffled and anonymised. A judge, who sees the turn, the recent context and the reference facts of the
world (every item stated before the turn), scores each response 0–3 for correctness and fit, and lists the facts it
got wrong or missed.

The downstream effect of memory on a turn is oracle − none. A turn *needs* memory when that effect is ≥ 1. This
validates the labels (plan vs labeler) and gives every system a downstream score: system − none.

    python3 benchmarks/memory-stream/downstream.py prep --world code [--n 60] [--system "vote:..."]
    python3 benchmarks/memory-stream/downstream.py items --world code      # order-free responder input
    python3 benchmarks/memory-stream/downstream.py collect --world code    # after the responders
    python3 benchmarks/memory-stream/downstream.py judge-prep --world code
    python3 benchmarks/memory-stream/downstream.py report --world code
"""
import argparse, glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def prep(a):
    import score, sleep, methods, judge
    stream, items = score.load_stream(a.world)
    cov = score.Coverage(items)
    evs = [e for e in score.scored_events(stream) if e["_split"] == "dev" and e["t"] == "human"]
    lab_path = os.path.join(HERE, "worlds", a.world, "labels.json")
    extra = json.load(open(lab_path)) if os.path.exists(lab_path) else {}
    rng = random.Random(5)
    plan = [e for e in evs if set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))]
    lab_only = [e for e in evs if e not in plan and set(extra.get(e["id"], [])) - e["_window"]]
    none = [e for e in evs if e not in plan and e not in lab_only]
    n = a.n
    pick = (rng.sample(plan, min(len(plan), n // 2)) + rng.sample(lab_only, min(len(lab_only), n // 4))
            + rng.sample(none, min(len(none), n - n // 2 - n // 4)))
    rows = sleep.rows(stream, a.world, strict=True)
    sysm = methods.make(a.system, rows, stream, items, cov) if a.system else None
    d = os.path.join(HERE, "downstream", a.sub or a.world)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases, key = [], {}
    for e in pick:
        needs = (set(e["labels"]["needs"]) | set(extra.get(e["id"], []))) - e["_window"]
        conds = {"none": [], "oracle": [items[i]["text"] for i in sorted(needs)]}
        if sysm:
            conds["system"] = [sysm.by_id[i]["text"] for i in sysm.packet(e, e["_order"])]
        order = list(conds)
        rng.shuffle(order)
        group = "plan" if e in plan else "labeler-only" if e in lab_only else "no-need"
        key[e["id"]] = {"group": group, "order": order, "needs": sorted(needs)}
        cases.append({"event": e["id"], "text": e["text_all"][:2500], "recent": judge.context(stream, e["id"]),
                      "packets": [conds[c] for c in order]})
    json.dump({"cases": cases, "output": f"benchmarks/memory-stream/downstream/{a.world}/out/responses.json"},
              open(os.path.join(d, "in", "responses-in.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"system": a.system, "key": key}, open(os.path.join(d, "key.json"), "w"), indent=1)
    print(len(cases), "cases", {g: sum(1 for k in key.values() if k["group"] == g) for g in ("plan", "labeler-only", "no-need")})


def prep_picks(a):
    """C4-E13: do a judge's picks help on turns the plan labels call no-need? Conditions: none / picks, on the dev
    judge-sample human turns where the plan says no need and the judge fired (plus as many where it fired on a need)."""
    import score, sleep, judge
    stream, items = score.load_stream(a.world)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    rows = {r["id"]: r for r in sleep.rows(stream, a.world, strict=True)}
    picks = judge.packets(a.world, "sleep", a.tag)
    rng = random.Random(9)
    vis_at = lambda r, e: r["t"] < e["_order"] and (r.get("invalid_at") is None or r["invalid_at"] > e["_order"])
    visible = lambda i: [r for r in picks[i] if r in rows and vis_at(rows[r], evs[i])]
    fired = sorted(i for i in picks if visible(i) and evs[i]["t"] == "human" and evs[i]["_split"] == "dev")
    noneed = [i for i in fired if not set(evs[i]["labels"]["needs"]) - set(evs[i]["labels"].get("in_context", []))]
    need = [i for i in fired if i not in noneed]
    pick = sorted(rng.sample(noneed, min(a.n, len(noneed))) + rng.sample(need, min(a.n // 2, len(need))))
    d = os.path.join(HERE, "downstream", a.sub)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases, key = [], {}
    for eid in pick:
        e = evs[eid]
        vis = [rows[r]["text"] for r in visible(eid)]
        conds = {"none": [], "picks": vis}
        order = list(conds)
        rng.shuffle(order)
        key[eid] = {"group": "no-need" if eid in noneed else "plan", "order": order, "needs": []}
        cases.append({"event": eid, "text": e["text_all"][:2500], "recent": judge.context(stream, eid),
                      "packets": [conds[c] for c in order]})
    json.dump({"cases": cases}, open(os.path.join(d, "in", "responses-in.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"system": f"judge:{a.tag}", "key": key}, open(os.path.join(d, "key.json"), "w"), indent=1)
    print(len(cases), "cases", {g: sum(1 for k in key.values() if k["group"] == g) for g in ("plan", "no-need")},
          "of", len(noneed), "no-need fires and", len(need), "need fires")


def items(a):
    """Order-free responder input: one item per (turn, packet), each with its own id (C4-E10: responders that answer
    a list of packets swapped the order). A turn's items never share a file: item j of every turn goes to group j,
    split into files of `per` (review of C4-E10: a responder that sees a turn with and without memory in one prompt
    copies facts into the no-memory reply)."""
    d = os.path.join(HERE, "downstream", a.sub or a.world)
    src = json.load(open(os.path.join(d, "in", "responses-in.json")))["cases"]
    rng = random.Random(13)
    groups = {}
    for c in src:
        for j, p in enumerate(c["packets"]):
            groups.setdefault(j, []).append({"id": f"{c['event']}#{j}", "text": c["text"], "recent": c["recent"],
                                             "packet": p})
    for j, out in sorted(groups.items()):
        rng.shuffle(out)
        for b in range(0, len(out), a.per):
            name = f"items-{j}-{b // a.per}"
            dest = f"benchmarks/memory-stream/downstream/{a.sub or a.world}/out/{name}.json"
            json.dump({"items": out[b:b + a.per], "output": dest},
                      open(os.path.join(d, "in", f"{name}.json"), "w"), indent=1, ensure_ascii=False)
            print(name, len(out[b:b + a.per]))


def collect(a):
    d = os.path.join(HERE, "downstream", a.sub or a.world)
    src = json.load(open(os.path.join(d, "in", "responses-in.json")))["cases"]
    got, who = {}, ""
    for p in glob.glob(os.path.join(d, "out", "items-*.json")):
        j = json.load(open(p))
        who = j.get("responder", who)
        got.update({x["id"]: x["response"] for x in j["items"]})
    cases = [{"event": c["event"], "responses": [got[f"{c['event']}#{j}"] for j in range(len(c["packets"]))]}
             for c in src]
    json.dump({"responder": who, "protocol": "items", "cases": cases},
              open(os.path.join(d, "out", "responses.json"), "w"), indent=1, ensure_ascii=False)
    print(len(cases), "cases collected")


def judge_prep(a):
    import score
    from evidence import History
    stream, items = score.load_stream(a.world)
    hist = History(stream)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    d = os.path.join(HERE, "downstream", a.sub or a.world)
    resp = json.load(open(os.path.join(d, "out", "responses.json")))["cases"]
    src = {c["event"]: c for c in json.load(open(os.path.join(d, "in", "responses-in.json")))["cases"]}
    cases = []
    for c in resp:
        e = evs[c["event"]]
        facts = [items[i]["text"] for i, t in sorted(e["_stated"].items(), key=lambda kv: kv[1])
                 if not (items[i].get("superseded_by") in e["_stated"])]
        s = src[c["event"]]
        base = s["text"] + " " + " ".join(x["text"] for x in s["recent"])
        cases.append({"event": c["event"], "text": s["text"], "recent": s["recent"], "reference_facts": facts,
                      "history_evidence": hist.evidence(c["event"], base, c["responses"]), "responses": c["responses"]})
    json.dump({"cases": cases, "output": f"benchmarks/memory-stream/downstream/{a.sub or a.world}/out/judged.json"},
              open(os.path.join(d, "in", "judge-in.json"), "w"), indent=1, ensure_ascii=False)
    print(len(cases), "cases for the judge")


def report(a):
    d = os.path.join(HERE, "downstream", a.sub or a.world)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = {}
    for p in glob.glob(os.path.join(d, "out", "judged*.json")):
        judged.update({c["event"]: c["scores"] for c in json.load(open(p))["cases"]})
    by = {}
    for eid, k in key.items():
        if eid not in judged:
            continue
        s = dict(zip(k["order"], judged[eid]))
        g = by.setdefault(k["group"], {"n": 0, "effect": 0.0, "needs": 0, "sys": 0.0})
        g["n"] += 1
        if "picks" in s:  # prep-picks runs: report picks − none in the effect columns
            s = dict(s, oracle=s["picks"])
        eff = s["oracle"] - s["none"]
        g["effect"] += eff
        g["needs"] += eff >= 1
        if "system" in s:
            g["sys"] += s["system"] - s["none"]
    for g, v in by.items():
        print(g, {"n": v["n"], "mean oracle−none": round(v["effect"] / v["n"], 3),
                  "share with effect ≥ 1": round(v["needs"] / v["n"], 3),
                  "mean system−none": round(v["sys"] / v["n"], 3)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep", "prep-picks", "items", "collect", "judge-prep", "report"])
    ap.add_argument("--sub", default="", help="subdirectory of downstream/ (default: the world)")
    ap.add_argument("--tag", default="", help="prep-picks: the judge run whose picks are tested")
    ap.add_argument("--world", required=True)
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--system", default="")
    ap.add_argument("--per", type=int, default=45)
    a = ap.parse_args()
    cmds = {"prep": prep, "prep-picks": prep_picks, "items": items, "collect": collect, "judge-prep": judge_prep,
            "report": report}
    cmds[a.cmd](a)
