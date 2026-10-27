"""F21 anticipation: a model prepares the next turn's packet *before* the turn arrives; the hook only checks it.

After each turn (Claude Code's async Stop hook runs while the user types), a model reads the session so far and the
store. It writes up to `k` predictions for the next moment, each a memory row plus a condition: a few short trigger
phrases that, if the next message contains any of them (or a close variant), make the memory needed.
`always: true` means needed whatever the next message says (e.g. an imminent calendar event).

At hook time the cost is a phrase check over a handful of prepared conditions, with no model.

The cases are the judge sample's moments (same events as judge and pull). The model sees only what came *before*
the moment (`recent` and the store visible then), never the moment's own text.

    python3 benchmarks/memory-stream/anticipate.py prep --world code
    score.py --world code --store sleep --strict --sample judge --systems "antic"            (condition check)
    score.py --world code --store sleep --strict --sample judge --systems "antic:mode=all"   (fire every prediction)
"""
import argparse, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def prep(world, per):
    d_in = os.path.join(HERE, "judge", f"{world}-sleep", "in")
    d = os.path.join(HERE, "anticipate", world)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    cases, store = [], {}
    for p in sorted(glob.glob(os.path.join(d_in, "*.json"))):
        j = json.load(open(p))
        for r in j["store"]:
            store[r["id"]] = r
        for c in j["cases"]:
            cases.append({"event": c["event"], "at": c["at"], "type_of_next": c["type"], "recent": c["recent"]})
    cases.sort(key=lambda c: c["at"])
    rows = sorted(store.values(), key=lambda r: r["from"])
    for b in range(0, len(cases), per):
        part = cases[b:b + per]
        last = max(c["at"] for c in part)
        name = f"a{b // per:02d}"
        json.dump({"batch": name, "store": [r for r in rows if r["from"] < last], "cases": part,
                   "output": f"benchmarks/memory-stream/anticipate/{world}/out/{name}.json"},
                  open(os.path.join(d, "in", f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(part))


def predictions(world):
    out = {}
    for p in glob.glob(os.path.join(HERE, "anticipate", world, "out", "*.json")):
        for c in json.load(open(p))["cases"]:
            out[c["event"]] = c.get("predictions", [])
    return out


def matches(text, phrases):
    t = (text or "").lower()
    for ph in phrases or []:
        words = [w for w in re.findall(r"[a-z0-9]+", ph.lower()) if len(w) > 2]
        if words and all(re.search(r"(?<![a-z0-9])" + re.escape(w[:5]), t) for w in words):
            return True
    return False


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--per", type=int, default=40)
    a = ap.parse_args()
    prep(a.world, a.per)
