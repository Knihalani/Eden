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
    d = os.path.join(HERE, "downstream", a.world)
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


def judge_prep(a):
    import score
    stream, items = score.load_stream(a.world)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    d = os.path.join(HERE, "downstream", a.world)
    resp = json.load(open(os.path.join(d, "out", "responses.json")))["cases"]
    src = {c["event"]: c for c in json.load(open(os.path.join(d, "in", "responses-in.json")))["cases"]}
    cases = []
    for c in resp:
        e = evs[c["event"]]
        facts = [items[i]["text"] for i, t in sorted(e["_stated"].items(), key=lambda kv: kv[1])
                 if not (items[i].get("superseded_by") in e["_stated"])]
        cases.append({"event": c["event"], "text": src[c["event"]]["text"], "recent": src[c["event"]]["recent"],
                      "reference_facts": facts, "responses": c["responses"]})
    json.dump({"cases": cases, "output": f"benchmarks/memory-stream/downstream/{a.world}/out/judged.json"},
              open(os.path.join(d, "in", "judge-in.json"), "w"), indent=1, ensure_ascii=False)
    print(len(cases), "cases for the judge")


def report(a):
    d = os.path.join(HERE, "downstream", a.world)
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
    ap.add_argument("cmd", choices=["prep", "judge-prep", "report"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--system", default="")
    a = ap.parse_args()
    {"prep": prep, "judge-prep": judge_prep, "report": report}[a.cmd](a)
