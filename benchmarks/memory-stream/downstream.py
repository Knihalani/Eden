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


def prep_eden(a):
    """C5-E3: the plugin as it ships today. The same turns and groups as `downstream/<world>` (C5-E1), with
    conditions none / eden: the bullets the real plugin injected at that turn's UserPromptSubmit."""
    import score
    stream, _ = score.load_stream(a.world)
    src = {c["event"]: c for c in json.load(open(os.path.join(HERE, "downstream", a.world, "in", "responses-in.json")))
           ["cases"]}
    base = json.load(open(os.path.join(HERE, "downstream", a.world, "key.json")))["key"]
    eden = {}
    for line in open(os.path.join(HERE, "runs", f"{a.world}-eden", "packets.jsonl")):
        if line.strip():
            p = json.loads(line)
            if p["hook"] == "UserPromptSubmit":
                eden.setdefault(p["event"], []).extend(score.parse_packet(p["content"]))
    rng = random.Random(17)
    d = os.path.join(HERE, "downstream", a.sub)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases, key = [], {}
    for eid in sorted(base):
        conds = {"none": [], "eden": eden.get(eid, [])}
        order = list(conds)
        rng.shuffle(order)
        key[eid] = {"group": base[eid]["group"], "order": order, "needs": base[eid]["needs"]}
        cases.append({"event": eid, "text": src[eid]["text"], "recent": src[eid]["recent"],
                      "packets": [conds[c] for c in order]})
    json.dump({"cases": cases}, open(os.path.join(d, "in", "responses-in.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"system": "eden (plugin today)", "key": key}, open(os.path.join(d, "key.json"), "w"), indent=1)
    fired = sum(1 for e in key if eden.get(e))
    print(len(cases), "cases;", fired, "with an eden packet")


def prep_verify(a):
    """C5-E4: the best push method so far (F22b, calibrated off-hook verifier), on the same turns as `downstream/
    <world>`. Conditions none / verify: rows with p ≥ a.p (≤ 4), visible at the turn, delivered only on a turn with
    a tool call (the deferred delivery point), else empty."""
    import score, sleep, verify
    stream, _ = score.load_stream(a.world)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    rows = {r["id"]: r for r in sleep.rows(stream, a.world, strict=True)}
    acts = score.action_text(stream)
    vp = verify.picks(a.world, "cal")
    vp.update(verify.picks(a.world, "cal-ds"))
    src = {c["event"]: c for c in json.load(open(os.path.join(HERE, "downstream", a.world, "in", "responses-in.json")))
           ["cases"]}
    base = json.load(open(os.path.join(HERE, "downstream", a.world, "key.json")))["key"]
    vis = lambda r, e: r["t"] < e["_order"] and (r.get("invalid_at") is None or r["invalid_at"] > e["_order"])
    day = {}  # event order → its session's date, to date a row by when it became visible (C5-E6)
    for sess in stream["sessions"]:
        for ev in sess["events"]:
            day[ev["_order"]] = sess["ts"][:10]
    dated = lambda r: f"[as of {day.get(int(r['t']), '?')}] {r['text']}" if a.dated else r["text"]
    rng = random.Random(19)
    d = os.path.join(HERE, "downstream", a.sub)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases, key, fired = [], {}, 0
    for eid in sorted(base):
        e = evs[eid]
        pick = [i for i, p in vp.get(eid, []) if p >= a.p and i in rows and vis(rows[i], e)][:4]
        packet = [dated(rows[i]) for i in pick] if acts.get(eid) else []
        fired += bool(packet)
        conds = {"none": [], "verify": packet}
        order = list(conds)
        rng.shuffle(order)
        key[eid] = {"group": base[eid]["group"], "order": order, "needs": base[eid]["needs"]}
        cases.append({"event": eid, "text": src[eid]["text"], "recent": src[eid]["recent"],
                      "packets": [conds[c] for c in order]})
    if a.fired_only:  # C5-E6 re-ran only the turns where verify fired
        cases = [c for c in cases if any(c["packets"])]
        key = {c["event"]: key[c["event"]] for c in cases}
    json.dump({"cases": cases}, open(os.path.join(d, "in", "responses-in.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"system": f"verify:cal,p={a.p} (deferred)", "key": key}, open(os.path.join(d, "key.json"), "w"),
              indent=1)
    print(len(cases), "cases;", fired, "with a packet;", sum(1 for e in base if e in vp), "had verifier output")


def prep_h2h(a):
    """C5-E7: head to head on fresh turns (none of downstream/<world>'s): none / eden (dated) / verify (dated, p ≥
    a.p, deferred). Stratified like C5-E1 but with more no-need turns: 30 plan-need, 15 labeler-only, 30 no-need.
    Eden's bullets are dated by the first earlier event containing them (they are mostly the user's past prompts)."""
    import score, sleep, verify, judge
    stream, items = score.load_stream(a.world)
    evs = [e for e in score.scored_events(stream) if e["_split"] == "dev" and e["t"] == "human"]
    byid = {e["id"]: e for e in score.scored_events(stream)}
    used = set()
    for sub in [a.world] + [x for x in a.exclude.split(",") if x]:  # turns already used by earlier runs
        used |= set(json.load(open(os.path.join(HERE, "downstream", sub, "key.json")))["key"])
    extra = json.load(open(os.path.join(HERE, "worlds", a.world, "labels.json")))
    rng = random.Random(a.seed)
    n_plan, n_lab, n_none = (int(x) for x in a.counts.split(","))
    pool = [e for e in evs if e["id"] not in used]
    plan = [e for e in pool if set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))]
    lab_only = [e for e in pool if e not in plan and set(extra.get(e["id"], [])) - e["_window"]]
    none = [e for e in pool if e not in plan and e not in lab_only]
    pick = (rng.sample(plan, min(n_plan, len(plan))) + rng.sample(lab_only, min(n_lab, len(lab_only)))
            + rng.sample(none, min(n_none, len(none))))
    day, flat = {}, []
    for sess in stream["sessions"]:
        for ev in sess["events"]:
            day[ev["_order"]] = sess["ts"][:10]
            flat.append(ev)
    eden = {}
    for line in open(os.path.join(HERE, "runs", f"{a.world}-eden", "packets.jsonl")):
        if line.strip():
            p = json.loads(line)
            if p["hook"] == "UserPromptSubmit":
                eden.setdefault(p["event"], []).extend(score.parse_packet(p["content"]))

    def eden_dated(e, b):
        src = next((ev for ev in flat if ev["_order"] < e["_order"] and b[:60] in ev.get("text_all", "")), None)
        return f"[as of {day[src['_order']]}] {b}" if src else b

    rows = {r["id"]: r for r in sleep.rows(stream, a.world, strict=True)}
    acts = score.action_text(stream)
    vp = verify.picks(a.world, "cal")
    for t in ("cal-ds", "cal-ds2", "cal-ds3"):
        vp.update(verify.picks(a.world, t))
    vis = lambda r, e: r["t"] < e["_order"] and (r.get("invalid_at") is None or r["invalid_at"] > e["_order"])
    d = os.path.join(HERE, "downstream", a.sub)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases, key, missing = [], {}, []
    for e in sorted(pick, key=lambda e: e["id"]):
        eid = e["id"]
        if eid not in vp:
            missing.append(eid)
        sel = [i for i, p in vp.get(eid, []) if p >= a.p and i in rows and vis(rows[i], e)][:4]
        vpk = [f"[as of {day.get(int(rows[i]['t']), '?')}] {rows[i]['text']}" for i in sel] if acts.get(eid) else []
        conds = {"none": [], "eden": [eden_dated(e, b) for b in eden.get(eid, [])], "verify": vpk}
        order = list(conds)
        rng.shuffle(order)
        group = "plan" if e in plan else "labeler-only" if e in lab_only else "no-need"
        key[eid] = {"group": group, "order": order, "needs": []}
        cases.append({"event": eid, "text": e["text_all"][:2500], "recent": judge.context(stream, eid),
                      "packets": [conds[c] for c in order]})
    json.dump({"cases": cases}, open(os.path.join(d, "in", "responses-in.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"system": f"h2h eden-dated vs verify:cal,p={a.p} dated", "key": key},
              open(os.path.join(d, "key.json"), "w"), indent=1)
    json.dump({"key": {i: 1 for i in missing}}, open(os.path.join(d, "missing.json"), "w"))
    print(len(cases), "cases;", len(missing), "need verifier outputs:",
          f"verify.py --events {os.path.join(d, 'missing.json')} --tag cal-ds2")


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
    for p in glob.glob(os.path.join(d, "out", "items-*-*.json")):  # per-turn-split files only (C4-R)
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
        alt = next((c for c in ("picks", "eden", "verify") if c in s), None)
        if alt:  # prep-picks / prep-eden / prep-verify runs: report that condition − none
            s = dict(s, oracle=s[alt])
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
    ap.add_argument("cmd", choices=["prep", "prep-picks", "prep-eden", "prep-verify", "prep-h2h", "items", "collect",
                                    "judge-prep", "report"])
    ap.add_argument("--sub", default="", help="subdirectory of downstream/ (default: the world)")
    ap.add_argument("--tag", default="", help="prep-picks: the judge run whose picks are tested")
    ap.add_argument("--world", required=True)
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--system", default="")
    ap.add_argument("--per", type=int, default=45)
    ap.add_argument("--p", type=float, default=0.6, help="prep-verify: verifier threshold")
    ap.add_argument("--dated", action="store_true",
                    help="prep-verify: prefix each row with the date it became visible (its batch's last session)")
    ap.add_argument("--counts", default="30,15,30", help="prep-h2h: plan-need, labeler-only, no-need turns")
    ap.add_argument("--seed", type=int, default=23, help="prep-h2h: sampling seed")
    ap.add_argument("--exclude", default="", help="prep-h2h: comma-separated downstream subs whose turns are used")
    ap.add_argument("--fired-only", action="store_true", help="prep-verify: keep only turns where verify fires")
    a = ap.parse_args()
    cmds = {"prep": prep, "prep-picks": prep_picks, "prep-eden": prep_eden, "prep-verify": prep_verify,
            "prep-h2h": prep_h2h, "items": items, "collect": collect, "judge-prep": judge_prep, "report": report}
    cmds[a.cmd](a)
