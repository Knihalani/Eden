"""StreamBench scorer: every retrieval system, turn by turn, on a world's labelled stream (BRIEF §4 metrics).

    python3 benchmarks/memory-stream/score.py --world code [--run DIR] [--systems "eden lex:tau=6 oracle-need"]
        [--store write|oracle] [--split dev|test|all] [--json OUT]

Systems
  eden          the plugin's own packets from a replay (`replay.ts`): what the product injects today
  <method>      an offline method from `methods.py`, run on a store:
                  write   the rows the plugin's write path stored (`store.json`), each visible from its write time
                          and until it is invalidated
                  oracle  one clean row per item, visible from the event that first states it, and until its
                          correction is stated (perfect extraction)
                  sleep   the rows a sleep compiler wrote (sleep.py, SLEEP-SPEC.md), each visible after its session

Which events are scored: every submit (human prompt, trigger, task notification, peer message), and every
`action` tool call (scored apart). A need is a planned need that is not already in the context window
(assemble.py `in_context`).

What a bullet covers: an oracle row covers its item. A write-path row or a packet bullet covers item i when it
holds ≥ 0.6 of i's content tokens, weighted by rarity (class Coverage, v2; κ 0.859 against a judge on 200
bullets).

Metrics (per class: human, trigger, nonhuman = notification + peer)
  recall        mean over need events of |needs covered| / |needs|; recall@4 uses the first 4 bullets only
  full          share of need events with every need covered
  precision     needed bullets / all bullets; `lenient` also counts bullets that cover an allowed item
  silence       share of no-need events with no packet
  proactive     recall over need_type proactive | event | action
  redundant     share of bullets covering an item already stated in the window
  stale         share of packets with a bullet for an item that a stated correction has replaced
  tokens        mean packet tokens (characters / 4) per event
  base rates    precision and the packet rate on no-need turns, reweighted so need turns are 5%, 8%, 15% of human
                turns (recall does not depend on the mix)
"""
import argparse, json, os, re, sys
from text import content, stems

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
SUBMITS = ("human", "trigger", "notification", "peer")
COVER = 0.6


def split_of(session_index):
    return "test" if session_index % 5 == 4 else "dev"


class Coverage:
    """Bullet → item coverage (v2, C2-E2): the idf-weighted share of the item's content tokens found in the bullet
    is ≥ COVER (0.6). A token's weight is 1 / (number of items that contain it), so rare value tokens (names, numbers,
    tools) count most. For a correction pair, the bullet must also hold ≥ 0.5 of the tokens that tell the two apart.
    Calibrated against a sonnet judge on 200 code-world bullets: κ 0.859 (v1, plain share ≥ 0.5: κ 0.609)."""

    def __init__(self, items):
        self.items = items
        self.content = {i: content(x["text"]) for i, x in items.items()}
        df = {}
        for c in self.content.values():
            for t in c:
                df[t] = df.get(t, 0) + 1
        self.w = {t: 1.0 / d for t, d in df.items()}
        self.distinct = {}
        for i, x in items.items():
            j = x.get("superseded_by")
            if j and j in items:
                self.distinct[i] = self.content[i] - self.content[j]
                self.distinct[j] = self.content[j] - self.content[i]
        self.index = {}
        for i, c in self.content.items():
            for t in c:
                self.index.setdefault(t, set()).add(i)

    def covers(self, text):
        have = stems(text)
        cand = set()
        for t in have:
            cand |= self.index.get(t, set())
        out = set()
        for i in cand:
            c = self.content[i]
            total = sum(self.w[t] for t in c)
            if not c or sum(self.w[t] for t in c if t in have) / total < COVER:
                continue
            d = self.distinct.get(i)
            if d and sum(1 for t in d if t in have) / len(d) < 0.5:
                continue
            out.add(i)
        return out


def parse_packet(text):
    bullets = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("- "):
            bullets.append(re.sub(r"\s*\((you said|from|the agent|rule|said)[^)]*\)\s*$", "", line[2:]))
    if not bullets and text.strip():
        bullets = [text.strip()]
    return bullets


def load_stream(world):
    s = json.load(open(os.path.join(HERE, "worlds", world, "stream.json")))
    items = {x["id"]: x for x in s["items"]}
    return s, items


def scored_events(stream):
    """Events to score, in stream order, with the window state (items stated in context) before each."""
    out = []
    window = set()
    order = 0
    files = set(stream["files"])
    stated_ever = {}
    for si, s in enumerate(stream["sessions"]):
        if s["kind"] != "resume":
            window = set()
        for e in s["events"]:
            lab = e["labels"]
            order += 1
            e["_order"] = order
            e["_split"] = split_of(si)
            if e["t"] == "compact":
                window = set(lab["states"])
                continue
            scorable = e["t"] in SUBMITS or lab.get("need_type") == "action"
            if scorable:
                e["_window"] = window | files
                e["_stated"] = dict(stated_ever)
                out.append(e)
            window |= set(lab["states"])
            for i in lab["states"]:
                stated_ever.setdefault(i, order)
    return out


def stale_items(stream, items, e):
    """Items whose correction was stated before this event."""
    st = e["_stated"]
    return {i for i, x in items.items() if x.get("superseded_by") in st}


def score(events, packets, cov, items, stream):
    """packets: event id -> list of (bullet text, covered item set)."""
    agg = {}

    def bucket(name):
        return agg.setdefault(name, {"need_n": 0, "recall": 0.0, "recall4": 0.0, "full": 0, "pro_n": 0, "pro": 0.0,
                                     "neg_n": 0, "neg_silent": 0, "bullets": 0, "needed_b": 0, "lenient_b": 0,
                                     "redundant_b": 0, "packets": 0, "stale_p": 0, "tokens": 0, "events": 0,
                                     "neg_bullets": 0, "neg_packets": 0, "need_bullets": 0, "need_needed_b": 0})

    for e in events:
        lab = e["labels"]
        cls = lab["class"]
        cls = "nonhuman" if cls in ("notification", "peer") else cls
        if lab.get("need_type") == "action":
            cls = "action"
        needs = set(lab["needs"]) - set(lab.get("in_context", []))
        allowed = set(lab.get("allowed", []))
        pk = packets.get(e["id"], [])
        stale = stale_items(stream, items, e)
        for name in (cls, "all"):
            b = bucket(name)
            b["events"] += 1
            b["tokens"] += sum(len(t) for t, _ in pk) / 4
            if pk:
                b["packets"] += 1
            covered = set().union(*[c for _, c in pk]) if pk else set()
            covered4 = set().union(*[c for _, c in pk[:4]]) if pk else set()
            nb = sum(1 for _, c in pk if c & needs)
            b["bullets"] += len(pk)
            b["needed_b"] += nb
            b["lenient_b"] += sum(1 for _, c in pk if c & (needs | allowed))
            b["redundant_b"] += sum(1 for _, c in pk if c & e["_window"])
            if any(c & stale for _, c in pk):
                b["stale_p"] += 1
            if needs:
                b["need_n"] += 1
                r = len(needs & covered) / len(needs)
                b["recall"] += r
                b["recall4"] += len(needs & covered4) / len(needs)
                b["full"] += needs <= covered
                b["need_bullets"] += len(pk)
                b["need_needed_b"] += nb
                nt = "nt:" + str(lab.get("need_type"))
                b.setdefault(nt, [0, 0.0])
                b[nt][0] += 1
                b[nt][1] += r
                if lab.get("need_type") in ("proactive", "event", "action"):
                    b["pro_n"] += 1
                    b["pro"] += r
            else:
                b["neg_n"] += 1
                b["neg_silent"] += not pk
                b["neg_bullets"] += len(pk)
                b["neg_packets"] += bool(pk)
    res = {}
    for name, b in agg.items():
        d = lambda x, y: round(x / y, 4) if y else None
        r = {"events": b["events"], "need_events": b["need_n"], "recall": d(b["recall"], b["need_n"]),
             "recall@4": d(b["recall4"], b["need_n"]), "full": d(b["full"], b["need_n"]),
             "proactive": d(b["pro"], b["pro_n"]), "proactive_n": b["pro_n"],
             "precision": d(b["needed_b"], b["bullets"]), "lenient": d(b["lenient_b"], b["bullets"]),
             "silence": d(b["neg_silent"], b["neg_n"]), "neg_events": b["neg_n"],
             "redundant": d(b["redundant_b"], b["bullets"]), "stale": d(b["stale_p"], b["packets"]),
             "tokens": d(b["tokens"], b["events"]), "bullets": b["bullets"]}
        r["by_need_type"] = {k[3:]: [v[0], round(v[1] / v[0], 3)] for k, v in b.items() if k.startswith("nt:")}
        if name == "human" and b["need_n"] and b["neg_n"]:
            rates = {}
            for rate in (0.05, 0.08, 0.15):
                w = rate / (1 - rate) * b["neg_n"] / b["need_n"]  # weight of a need event
                bul = w * b["need_bullets"] + b["neg_bullets"]
                rates[str(rate)] = {"precision": d(w * b["need_needed_b"], bul),
                                    "false_packet_rate": d(b["neg_packets"], b["neg_n"])}
            r["base_rates"] = rates
        res[name] = r
    return res


def source_index(stream):
    """Content-token index of every event, to trace a bullet to the event it was copied from."""
    idx, src = {}, {}
    for s in stream["sessions"]:
        for e in s["events"]:
            c = content(e["text_all"])
            src[e["id"]] = (e["t"], c)
            for t in c:
                idx.setdefault(t, set()).add(e["id"])
    return idx, src


def trace(text, idx, src):
    """The event type a bullet most likely came from (≥ 0.7 of its content tokens), else None."""
    c = content(text)
    if not c:
        return None
    hits = {}
    for t in c:
        for ev in idx.get(t, ()):
            hits[ev] = hits.get(ev, 0) + 1
    best = max(sorted(hits), key=hits.get, default=None)
    return src[best][0] if best and hits[best] / len(c) >= 0.7 else None


def decompose(events, packets, stream, items):
    """Classes of every injected bullet on every scored event: where the noise comes from."""
    idx, src = source_index(stream)
    out = {}
    for e in events:
        lab = e["labels"]
        needs = set(lab["needs"]) - set(lab.get("in_context", []))
        allowed = set(lab.get("allowed", []))
        stale = stale_items(stream, items, e)
        for text, c in packets.get(e["id"], []):
            if c & needs:
                k = "needed"
            elif c & stale:
                k = "stale"
            elif c & e["_window"]:
                k = "in-context"
            elif c & allowed:
                k = "allowed"
            elif c:
                k = "other-item"
            else:
                k = "noise:" + (trace(text, idx, src) or "untraced")
            out[k] = out.get(k, 0) + 1
    total = sum(out.values()) or 1
    return {k: [v, round(v / total, 3)] for k, v in sorted(out.items(), key=lambda kv: -kv[1])}


def bootstrap(events, packets, cov, items, stream, n=500, seed=11):
    """95% percentile intervals of human recall, silence and precision, resampling events with replacement."""
    import random
    rng = random.Random(seed)
    hum = [e for e in events if e["labels"]["class"] == "human" and e["labels"].get("need_type") != "action"]
    vals = {"recall": [], "silence": [], "precision": []}
    for _ in range(n):
        smp = [rng.choice(hum) for _ in hum]
        r = score(smp, packets, cov, items, stream).get("human", {})
        for k in vals:
            if r.get(k) is not None:
                vals[k].append(r[k])
    ci = {}
    for k, v in vals.items():
        v.sort()
        ci[k] = [round(v[int(0.025 * len(v))], 4), round(v[int(0.975 * len(v)) - 1], 4)] if v else None
    return ci


def eden_packets(run, cov):
    out = {}
    for line in open(os.path.join(run, "packets.jsonl")):
        line = line.strip()
        if not line:
            continue
        p = json.loads(line)
        if p["hook"] != "UserPromptSubmit":
            continue
        out.setdefault(p["event"], []).extend((b, cov.covers(b)) for b in parse_packet(p["content"]))
    return out


def write_store(run):
    d = json.load(open(os.path.join(run, "store.json")))
    rows = []
    for r in d["rows"]:
        rows.append({"id": r["id"], "text": r["text"], "kind": r.get("kind"), "t": r.get("t") or 0,
                     "invalid_at": r.get("invalid_at")})
    return rows


def oracle_store(stream, items, events):
    """One row per item, visible from its first statement until its correction is stated (event order)."""
    first = {}
    for s in stream["sessions"]:
        for e in s["events"]:
            for i in e["labels"]["states"]:
                first.setdefault(i, e["_order"] if "_order" in e else 0)
    for i in stream["files"]:
        first[i] = 0
    rows = []
    for i, t in first.items():
        x = items[i]
        j = x.get("superseded_by")
        rows.append({"id": i, "text": x["text"], "kind": x["kind"], "t": t,
                     "invalid_at": first.get(j) if j else None, "item": i})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--run")
    ap.add_argument("--systems", default="eden lex oracle-need")
    ap.add_argument("--store", default="write")
    ap.add_argument("--split", default="dev")
    ap.add_argument("--sleep-tag", default="out")
    ap.add_argument("--strict", action="store_true", help="leak-free sleep store: rows visible after their batch")
    ap.add_argument("--ci", action="store_true", help="bootstrap 95%% intervals (human recall, silence, precision)")
    ap.add_argument("--labels", default="plan", choices=["plan", "union"],
                    help="plan: the needs the stream was written to; union: plus the independent labeler's")
    ap.add_argument("--json")
    a = ap.parse_args()
    stream, items = load_stream(a.world)
    cov = Coverage(items)
    events = scored_events(stream)
    if a.labels == "union":
        lab_path = os.path.join(HERE, "worlds", a.world, "labels.json")
        extra = json.load(open(lab_path)) if os.path.exists(lab_path) else {}
        for e in events:
            add = [i for i in extra.get(e["id"], []) if i not in e["labels"]["needs"] and i not in e["_window"]]
            if add:
                e["labels"] = dict(e["labels"], needs=e["labels"]["needs"] + add)
                e["labels"].setdefault("need_type", "incidental")
    if a.split != "all":
        events = [e for e in events if e["_split"] == a.split]
    run = a.run or os.path.join(HERE, "runs", a.world)
    times = json.load(open(os.path.join(run, "times.json"))) if os.path.exists(os.path.join(run, "times.json")) else {}
    if times:
        events = [e for e in events if e["id"] in times]
    results = {}
    import methods
    for name in a.systems.split():
        if name == "eden":
            pk = eden_packets(run, cov)
            results[name] = score(events, pk, cov, items, stream)
            results[name]["bullet_classes"] = decompose(events, pk, stream, items)
            if a.ci:
                results[name]["ci95"] = bootstrap(events, pk, cov, items, stream)
            continue
        if a.store == "write":
            rows = write_store(run)
            clock = lambda e: times.get(e["id"], 0)
        elif a.store == "sleep":
            import sleep
            rows = sleep.rows(stream, a.world, a.sleep_tag, strict=a.strict)
            clock = lambda e: e["_order"]
        else:
            rows = oracle_store(stream, items, events)
            clock = lambda e: e["_order"]
        for r in rows:
            if "item" in r:
                r["covers"] = {r["item"]}
        if name == "judge":
            import judge
            jp = judge.packets(a.world, a.store)
            byid = {r["id"]: r for r in rows}
            for r in rows:
                r.setdefault("covers", cov.covers(r["text"]))
            jev = [e for e in events if e["id"] in jp]
            vis = lambda r, e: r["t"] < e["_order"] and (r.get("invalid_at") is None or r["invalid_at"] > e["_order"])
            pk = {e["id"]: [(byid[i]["text"], byid[i]["covers"]) for i in jp[e["id"]] if i in byid and vis(byid[i], e)]
                  for e in jev}
            results[f"judge@{a.store}"] = score(jev, pk, cov, items, stream)
            results[f"judge@{a.store}"]["bullet_classes"] = decompose(jev, pk, stream, items)
            if a.ci:
                results[f"judge@{a.store}"]["ci95"] = bootstrap(jev, pk, cov, items, stream)
            continue
        m = methods.make(name, rows, stream, items, cov)
        pk = {}
        for e in events:
            now = clock(e)
            ids = m.packet(e, now)
            byid = m.by_id
            pk[e["id"]] = [(byid[i]["text"], byid[i]["covers"]) for i in ids]
        results[f"{name}@{a.store}"] = score(events, pk, cov, items, stream)
        results[f"{name}@{a.store}"]["bullet_classes"] = decompose(events, pk, stream, items)
        if a.ci:
            results[f"{name}@{a.store}"]["ci95"] = bootstrap(events, pk, cov, items, stream)
    print(json.dumps(results, indent=1))
    if a.json:
        json.dump(results, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
