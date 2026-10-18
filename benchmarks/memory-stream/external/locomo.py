"""LoCoMo as a StreamBench external anchor (BRIEF §4.8).

    python3 -I benchmarks/memory-stream/external/locomo.py

Fetches `locomo10.json` from github.com/snap-research/locomo into `external/cache/` (git-ignored). LoCoMo is
released for research under CC BY-NC 4.0 (the dataset's own statement). Never commit it, or anything derived
from its text. Writes one stream per conversation to `worlds/locomo-<sample>/stream.json` (git-ignored).

Conversion:
- Speaker A is the user, speaker B is the assistant role. Each dialogue turn is an item and states itself.
- Every QA is a probe: a human event in a final session after the conversation, needing its evidence turns.
- Category 5 (adversarial: the conversation does not hold the answer) is a negative probe that needs nothing.
- The dialogue turns themselves are human events with no need, so silence is measured on them too.
"""
import json, os, re, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
WORLDS = os.path.join(HERE, "..", "worlds")


def fetch():
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "locomo10.json")
    if not os.path.exists(path):
        urllib.request.urlretrieve(URL, path)
    return json.load(open(path))


def stamp(text):
    # "1:56 pm on 8 May, 2023" -> ISO minutes; unparseable stamps keep order only
    import datetime as dt
    m = re.match(r"(\d+):(\d+) (am|pm) on (\d+) (\w+), (\d+)", text or "")
    if not m:
        return None
    h, mi, ap, d, mon, y = m.groups()
    h = int(h) % 12 + (12 if ap == "pm" else 0)
    t = dt.datetime.strptime(f"{d} {mon} {y}", "%d %B %Y").replace(hour=h, minute=int(mi))
    return t.isoformat(timespec="minutes")


def convert(conv):
    sid = conv["sample_id"]
    c = conv["conversation"]
    a = c["speaker_a"]
    items, sessions = [], []
    n = 1
    while f"session_{n}" in c:
        events = []
        for i, turn in enumerate(c[f"session_{n}"]):
            iid = turn["dia_id"]
            text = turn["text"] + (f" [shared an image: {turn['blip_caption']}]" if turn.get("blip_caption") else "")
            items.append({"id": iid, "text": f"{turn['speaker']}: {text}", "kind": "turn", "subject": ""})
            t = "human" if turn["speaker"] == a else "assistant"
            lab = {"class": "human" if t == "human" else "assistant", "states": [iid], "needs": [],
                   "forbidden": [], "allowed": []}
            if t == "human":
                lab["neg"] = "dialogue"
            events.append({"id": f"{sid}-s{n:02d}-e{i:03d}", "t": t, "text": text, "labels": lab,
                           "text_all": text, "session": f"{sid}-s{n:02d}"})
        sessions.append({"id": f"{sid}-s{n:02d}", "ts": stamp(c.get(f"session_{n}_date_time")), "kind": "startup",
                         "author": "LoCoMo (snap-research), human-verified", "events": events})
        n += 1
    probes = []
    known = {x["id"] for x in items}
    for j, q in enumerate(conv["qa"]):
        ev = [e for e in q.get("evidence", []) if e in known]
        cat = q.get("category")
        lab = {"class": "human", "states": [], "needs": ev if cat != 5 else [], "forbidden": [], "allowed": [],
               "need_type": f"locomo-cat{cat}" if cat != 5 else None, "in_context": []}
        if cat == 5 or not ev:
            lab["neg"] = "adversarial" if cat == 5 else "no-evidence"
            lab["needs"] = []
        probes.append({"id": f"{sid}-probe-{j:04d}", "t": "human", "text": q["question"], "labels": lab,
                       "text_all": q["question"], "session": f"{sid}-probe"})
    sessions.append({"id": f"{sid}-probe", "ts": None, "kind": "startup", "author": "LoCoMo QA", "events": probes})
    return sid, {"world": f"locomo-{sid}", "files": [], "items": items, "sessions": sessions}


def main():
    data = fetch()
    for conv in data:
        sid, stream = convert(conv)
        d = os.path.join(WORLDS, f"locomo-{sid}")
        os.makedirs(d, exist_ok=True)
        json.dump(stream, open(os.path.join(d, "stream.json"), "w"))
        need = sum(1 for e in stream["sessions"][-1]["events"] if e["labels"]["needs"])
        print(sid, len(stream["items"]), "turns", len(stream["sessions"]) - 1, "sessions", need, "need probes")


if __name__ == "__main__":
    main()
