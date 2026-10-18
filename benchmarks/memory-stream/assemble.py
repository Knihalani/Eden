"""Checks authored batches against the plan and assembles a world's labelled stream.

    python3 benchmarks/memory-stream/assemble.py --world code [--strict]

Writes `worlds/<world>/stream.json`. Each event gets an id, its class and its oracle labels:

  states      items whose content this event states (planned, plus any unplanned statement the checker finds)
  needs       items the moment needs (human turns, triggers and `action` tool calls), from the plan
  need_type   direct | indirect | proactive | multi | stale | event
  forbidden   superseded items it would be wrong to show
  allowed     items the human text mentions by subject (a bullet for one is not false, and not needed)
  in_context  needed items already stated in the context window. They are not needs (BRIEF §4.4); score.py
              drops them
  neg         the negative category of a human turn with no need

The checker reports every rule the text breaks (AUTHORING.md). `--strict` exits non-zero on any.
Thresholds: a `state` beat holds when ≥ 0.6 of the item's content tokens are in its channel. A `need` leaks when
≥ 0.5 of the item's non-subject content tokens appear in the turn's text before and including the reply. An
unplanned statement is any event covering ≥ 0.8 of an item's content tokens (and at least 3 of them).
"""
import argparse, glob, json, os, sys
from text import content, coverage, stems

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_MIN, LEAK_MAX, EXTRA_MIN = 0.6, 0.5, 0.8


def event_text(e):
    t = e["t"]
    if t == "tool":
        inp = e.get("input") or {}
        return " ".join(str(v) for v in inp.values()) + "\n" + (e.get("output") or "")
    if t == "notification":
        return (e.get("task") or "") + "\n" + (e.get("report") or "")
    if t == "compact":
        return e.get("summary") or ""
    return e.get("text") or ""


def subject_tokens(item):
    return content(item.get("subject") or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args()
    wdir = os.path.join(HERE, "worlds", a.world)
    plan = json.load(open(os.path.join(wdir, "plan.json")))
    items = {x["id"]: x for x in json.load(open(os.path.join(ROOT, plan["config"]["items"])))}
    authored = {}
    authors = {}
    for p in sorted(glob.glob(os.path.join(wdir, "authored", "*.json"))):
        d = json.load(open(p))
        for s in d["sessions"]:
            authored[s["id"]] = s["events"]
            authors[s["id"]] = d.get("author", "?")
    problems = []
    out_sessions = []
    item_content = {i: content(x["text"]) for i, x in items.items()}
    for s in plan["sessions"]:
        if s["id"] not in authored:
            continue
        evs = authored[s["id"]]
        turns = {t["k"]: t for t in s["turns"]}
        trig = list(s["triggers"])
        cur_k = None
        cur_trigger = None
        out = []
        for n, e in enumerate(evs):
            e = dict(e)
            e["id"] = f"{s['id']}-e{n:03d}"
            e["session"] = s["id"]
            t = e["t"]
            lab = {"states": [], "needs": [], "forbidden": [], "allowed": []}
            if t == "human":
                cur_k, cur_trigger = e.get("k"), None
                lab["class"] = "human"
                beats = turns.get(cur_k, {}).get("beats", [])
                for b in beats:
                    if b["type"] == "need":
                        lab["needs"] += b["items"]
                        lab["need_type"] = b["need_type"]
                        lab["forbidden"] += b.get("forbidden", [])
                        if b.get("action"):
                            lab["action_planned"] = True
                    if b["type"] == "neg":
                        lab["neg"] = b["neg"]
                        if b["neg"] == "restate":
                            lab["states"] += b["items"]
                    if b["type"] == "state":
                        lab.setdefault("state_beats", []).append(b)
                txt = e.get("text") or ""
                toks = stems(txt)
                for i, x in items.items():
                    st = subject_tokens(x)
                    if st and st <= toks and i not in lab["needs"]:
                        lab["allowed"].append(i)
            elif t == "trigger":
                cur_k = None
                lab["class"] = "trigger"
                if trig:
                    tb = trig.pop(0)["beat"]
                    lab["needs"] = list(tb["items"])
                    if tb["items"]:
                        lab["need_type"] = "event"
                    lab["trigger"] = tb["trigger"]
                cur_trigger = e["id"]
            elif t in ("notification", "peer"):
                lab["class"] = t
            elif t == "tool":
                lab["class"] = "tool"
                lab["turn"] = cur_k
                if e.get("action") and cur_k is not None:
                    for b in turns.get(cur_k, {}).get("beats", []):
                        if b["type"] == "need" and b.get("action"):
                            lab["needs"] = list(b["items"])
                            lab["need_type"] = "action"
                            lab["forbidden"] = list(b.get("forbidden", []))
            else:
                lab["class"] = t
                lab["turn"] = cur_k
            e["labels"] = lab
            e["text_all"] = event_text(e)
            out.append(e)
        # --- structure checks
        ks = [e["k"] for e in out if e["t"] == "human"]
        if ks != sorted(turns):
            problems.append((s["id"], "turns", f"human k {ks} != plan {sorted(turns)}"))
        nh = {"notification": 0, "peer": 0}
        for x in s["nonhuman"]:
            nh[x["kind"]] += 1
        got = {k: sum(1 for e in out if e["t"] == k) for k in nh}
        if got != nh:
            problems.append((s["id"], "nonhuman", f"{got} != {nh}"))
        if sum(1 for e in out if e["t"] == "trigger") != len(s["triggers"]):
            problems.append((s["id"], "triggers", "count"))
        # --- state beats: find the event(s) of the channel in the turn that carry the item
        for e in out:
            if e["t"] != "human":
                continue
            k = e["k"]
            turn_events = [x for x in out if x.get("labels", {}).get("turn") == k and x["t"] != "human"]
            turn_events = [x for x in turn_events if out.index(x) > out.index(e)]
            # stop at the next human/trigger
            nxt = [out.index(x) for x in out if x["t"] in ("human", "trigger") and out.index(x) > out.index(e)]
            end = nxt[0] if nxt else len(out)
            span = out[out.index(e):end]
            for b in e["labels"].pop("state_beats", []):
                ch = b["channel"]
                pool = {"user": [e], "tool": [x for x in span if x["t"] == "tool"],
                        "assistant": [x for x in span if x["t"] == "assistant"]}[ch]
                for i in b["items"]:
                    best = max(pool, key=lambda x: coverage(items[i]["text"], x["text_all"]), default=None)
                    cov = coverage(items[i]["text"], best["text_all"]) if best else 0
                    if cov < STATE_MIN:
                        # accept any event of the turn
                        best = max(span, key=lambda x: coverage(items[i]["text"], x["text_all"]))
                        cov2 = coverage(items[i]["text"], best["text_all"])
                        problems.append((e["id"], "state", f"{i} {ch} cov {cov:.2f} (any event {cov2:.2f})"))
                        if cov2 < STATE_MIN:
                            continue
                    best["labels"]["states"].append(i)
            # --- need leak
            lab = e["labels"]
            for i in lab["needs"]:
                excl = subject_tokens(items[i])
                text = " ".join(x["text_all"] for x in span if x["t"] in ("human", "assistant"))
                cov = coverage(items[i]["text"], text, exclude=excl)
                if cov >= LEAK_MAX:
                    problems.append((e["id"], "leak", f"{i} {lab['need_type']} {cov:.2f}"))
                    lab.setdefault("leaked", []).append(i)
        for e in out:
            if e["labels"].get("need_type") == "action" or (e["t"] == "trigger" and e["labels"]["needs"]):
                pass
        # unplanned statements
        for e in out:
            if e["t"] == "human" and e["labels"]["needs"]:
                pass
            have = stems(e["text_all"])
            for i, c in item_content.items():
                if i in e["labels"]["states"] or len(c) < 3:
                    continue
                hit = sum(1 for t in c if t in have)
                if hit / len(c) >= EXTRA_MIN:
                    e["labels"]["states"].append(i)
                    e["labels"].setdefault("unplanned_states", []).append(i)
        out_sessions.append({k: v for k, v in s.items() if k not in ("turns", "triggers", "nonhuman")} | {
            "author": authors[s["id"]], "events": out})
    # --- context windows: needed items stated earlier in the window are in context, not needs
    in_ctx_total = 0
    files = set(plan["files"])
    window = set()
    for s in out_sessions:
        if s["kind"] != "resume":
            window = set()
        for e in s["events"]:
            lab = e["labels"]
            if e["t"] == "compact":
                window = set(lab["states"])
                continue
            if lab["needs"]:
                ctx = [i for i in lab["needs"] if i in window or i in files]
                lab["in_context"] = ctx
                in_ctx_total += len(ctx)
            window |= set(lab["states"])
    stream = {"world": a.world, "plan_seed": plan["seed"], "files": plan["files"],
              "items": [items[i] for i in items], "sessions": out_sessions}
    json.dump(stream, open(os.path.join(wdir, "stream.json"), "w"), indent=0, ensure_ascii=False)
    kinds = {}
    for p in problems:
        kinds[p[1]] = kinds.get(p[1], 0) + 1
    evs = [e for s in out_sessions for e in s["events"]]
    print(json.dumps({"sessions": len(out_sessions), "of_plan": len(plan["sessions"]), "events": len(evs),
                      "problems": kinds, "in_context_needs": in_ctx_total,
                      "unplanned_states": sum(len(e["labels"].get("unplanned_states", [])) for e in evs)}))
    for p in problems[:60]:
        print("  ", *p)
    if a.strict and problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
