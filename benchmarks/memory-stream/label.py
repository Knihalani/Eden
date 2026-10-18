"""Independent need labels for StreamBench (oracle discipline, BRIEF §4.4).

The plan's labels say which turns were *written* to need which items. In a rich store, ordinary turns can need an
item too: a refactor of billing code needs "billing changes need Jordan's review". An independent labeler, on a
different model from the authors, reads every human turn and trigger with the items stated before it. It marks the
items a careful expert would need to do that turn right.

    python3 benchmarks/memory-stream/label.py prep --world code [--batch 10]
    python3 benchmarks/memory-stream/label.py merge --world code     # writes labels.json, prints agreement

`merge` writes `worlds/<world>/labels.json`: {event id: [item ids]}. assemble.py reads it when present, and the
needs become plan ∪ labeler (the plan's own beats keep their need type; labeler-only needs get `incidental`).
"""
import argparse, glob, json, os

HERE = os.path.dirname(os.path.abspath(__file__))


def prep(world, batch):
    stream = json.load(open(os.path.join(HERE, "worlds", world, "stream.json")))
    items = {x["id"]: x for x in stream["items"]}
    first, replaced = {}, {}
    order = 0
    turns = []
    for s in stream["sessions"]:
        for e in s["events"]:
            order += 1
            if e["t"] in ("human", "trigger"):
                turns.append((s["id"], order, e))
            for i in e["labels"]["states"]:
                first.setdefault(i, order)
    for i in stream["files"]:
        first[i] = 0
    for i, x in items.items():
        j = x.get("superseded_by")
        if j in first:
            replaced[i] = first[j]
    d = os.path.join(HERE, "label", world, "in")
    os.makedirs(d, exist_ok=True)
    os.makedirs(os.path.join(HERE, "label", world, "out"), exist_ok=True)
    sess = [s["id"] for s in stream["sessions"]]
    for b in range(0, len(sess), batch):
        ids = set(sess[b:b + batch])
        cases = []
        for sid, at, e in turns:
            if sid not in ids:
                continue
            prev = []
            for s in stream["sessions"]:
                if s["id"] == sid:
                    k = [x["id"] for x in s["events"]].index(e["id"])
                    prev = [{"t": x["t"], "text": x["text_all"][:400]} for x in s["events"][max(0, k - 6):k]
                            if x["t"] in ("human", "assistant", "trigger", "peer", "notification", "compact")]
            cases.append({"event": e["id"], "at": at, "type": e["t"], "text": e["text_all"][:2500], "recent": prev})
        last = max(c["at"] for c in cases)
        avail = [{"id": i, "text": items[i]["text"], "from": first[i], "until": replaced.get(i)}
                 for i in sorted(first, key=first.get) if first[i] < last]
        name = f"{world}-label-b{b // batch:02d}"
        json.dump({"batch": name, "items": avail, "cases": cases,
                   "output": f"benchmarks/memory-stream/label/{world}/out/{name}.json"},
                  open(os.path.join(d, f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(cases), "cases", len(avail), "items")


def merge(world):
    stream = json.load(open(os.path.join(HERE, "worlds", world, "stream.json")))
    labels = {}
    for p in glob.glob(os.path.join(HERE, "label", world, "out", "*.json")):
        for c in json.load(open(p))["cases"]:
            labels[c["event"]] = sorted(set(c.get("needed", [])))
    json.dump(labels, open(os.path.join(HERE, "worlds", world, "labels.json"), "w"), indent=0)
    both = plan_only = lab_only = turns = need_turns_plan = need_turns_lab = 0
    for s in stream["sessions"]:
        for e in s["events"]:
            if e["id"] not in labels:
                continue
            turns += 1
            p, l = set(e["labels"]["needs"]), set(labels[e["id"]])
            both += len(p & l)
            plan_only += len(p - l)
            lab_only += len(l - p)
            need_turns_plan += bool(p)
            need_turns_lab += bool(l)
    print(json.dumps({"turns": turns, "need_turns_plan": need_turns_plan, "need_turns_labeler": need_turns_lab,
                      "items_both": both, "plan_only": plan_only, "labeler_only": lab_only,
                      "labeler_recall_of_plan": round(both / max(1, both + plan_only), 3)}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep", "merge"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--batch", type=int, default=10)
    a = ap.parse_args()
    prep(a.world, a.batch) if a.cmd == "prep" else merge(a.world)
