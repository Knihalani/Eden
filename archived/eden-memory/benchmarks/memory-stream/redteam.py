"""Red-team rounds (BRIEF §5 rule 5): fresh hard, realistic cases appended to a world's timeline.

A red-team author (a different instance from the stream authors) writes new sessions that continue a world after its
last session. Each human and trigger event carries explicit labels. This builds world `<world>-rt<N>`: the whole
base stream (so every store and every history is there), then the new sessions. score.py reports them as split
`fresh` (`--split fresh`), apart from the frozen dev and test splits.

    python3 benchmarks/memory-stream/redteam.py --world code --round 1
    python3 benchmarks/memory-stream/score.py --world code-rt1 --store sleep --strict --split fresh --systems ...

Statements in the new sessions are found mechanically (an event covering ≥ 0.8 of an item's content tokens), as
assemble.py finds unplanned ones. Needs already stated in the window become `in_context`.
"""
import argparse, json, os, sys
from text import content, stems

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from assemble import event_text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--round", type=int, default=1)
    a = ap.parse_args()
    base = json.load(open(os.path.join(HERE, "worlds", a.world, "stream.json")))
    rt = json.load(open(os.path.join(HERE, "redteam", f"{a.world}-rt{a.round}.json")))
    items = {x["id"]: x for x in base["items"]}
    item_c = {i: content(x["text"]) for i, x in items.items()}
    new_sessions = []
    bad = 0
    for s in rt["sessions"]:
        evs = []
        for n, e in enumerate(s["events"]):
            e = dict(e)
            e["id"] = f"{s['id']}-e{n:03d}"
            e["session"] = s["id"]
            given = e.pop("labels", None) or {}
            lab = {"class": e["t"] if e["t"] in ("human", "trigger", "notification", "peer") else e["t"],
                   "states": [], "needs": [i for i in given.get("needs", []) if i in items], "forbidden": [],
                   "allowed": [], "author": rt.get("author")}
            bad += len(given.get("needs", [])) - len(lab["needs"])
            if lab["needs"]:
                lab["need_type"] = given.get("need_type") or "direct"
            elif e["t"] in ("human", "trigger"):
                lab["neg"] = given.get("neg") or "none"
            e["text_all"] = event_text(e)
            have = stems(e["text_all"])
            for i, c in item_c.items():
                if len(c) >= 3 and sum(1 for t in c if t in have) / len(c) >= 0.8:
                    lab["states"].append(i)
            e["labels"] = lab
            evs.append(e)
        new_sessions.append({"id": s["id"], "ts": s["ts"], "kind": s.get("kind", "startup"),
                             "author": rt.get("author"), "events": evs})
    window = set()
    for s in new_sessions:
        window = set() if s["kind"] != "resume" else window
        for e in s["events"]:
            lab = e["labels"]
            if lab["needs"]:
                lab["in_context"] = [i for i in lab["needs"] if i in window or i in base["files"]]
            window |= set(lab["states"])
    out = dict(base, world=f"{a.world}-rt{a.round}", sessions=base["sessions"] + new_sessions)
    d = os.path.join(HERE, "worlds", f"{a.world}-rt{a.round}")
    os.makedirs(d, exist_ok=True)
    json.dump(out, open(os.path.join(d, "stream.json"), "w"), indent=0, ensure_ascii=False)
    hum = [e for s in new_sessions for e in s["events"] if e["t"] in ("human", "trigger")]
    need = [e for e in hum if set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))]
    words = sorted(len(e["text"].split()) for e in hum if e["t"] == "human")
    print(json.dumps({"world": out["world"], "new_sessions": len(new_sessions), "human+trigger": len(hum),
                      "need": len(need), "unknown_item_ids": bad, "human_words_p50": words[len(words) // 2]}))


if __name__ == "__main__":
    main()
