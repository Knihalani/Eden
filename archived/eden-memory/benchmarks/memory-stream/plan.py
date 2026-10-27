"""StreamBench planner: the beat schedule of one world's stream (R10, BRIEF §4).

A world is a set of oracle items (one atomic memory each; a correction is an item whose predecessor names it in
`superseded_by`). The planner decides, deterministically from a seed:

  - the sessions: when (simulated time over weeks or months), how many human turns (R6's distribution), resumes,
    compactions, and the non-human events (task notifications, peer agents) at R6's share of prompt events;
  - when and how each item is first stated: by the user, in tool output the agent reads, by the agent itself, or in
    a project file that is always in context (coding);
  - the need beats: which human turn, trigger or agent action needs which items, and why (direct, indirect,
    proactive, multi, stale-after-correction, event);
  - the hard-negative beats (general knowledge on the user's topics, other project or person, chit-chat and acks,
    long pastes, restating what is already in context) and plain task turns.

Authors (LLM subagents, AUTHORING.md) then write the text of every event to the plan; `assemble.py` checks it and
builds the stream. Labels come from the plan, never from the text, and the mechanical checks hold the text to them.

    python3 benchmarks/memory-stream/plan.py --world code|life [--seed 1]
"""
import argparse, datetime as dt, json, math, os, random, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))

# R6 §2: human prompts per session (p25 1 / p50 3 / p75 7 / p90 10 / max 24); capped at 12 to bound authoring.
HUMAN_KNOTS = [(0, 1), (0.25, 1), (0.5, 3), (0.75, 7), (0.9, 10), (1, 12)]
# R6: 97 non-human of 177 prompt events in 23 sessions = 0.45 → 0.82 non-human per human prompt.
NONHUMAN_PER_HUMAN = 0.82
NEED_RATE = 0.14  # share of human turns with a need beat (BRIEF §4.3: 8–15%; lower rates are scored by subsampling)

WORLDS = {
    "code": {
        "items": "benchmarks/memory-cues/fixture/memories.json",
        "start": "2026-08-17T09:00", "end": "2026-10-23T18:00", "sessions": 110, "weekdays": True,
        "hours": (8, 20), "scopes": True,
        "neg": {"task": 0.40, "ack": 0.17, "general": 0.10, "other": 0.09, "paste": 0.07, "restate": 0.07,
                "chitchat": 0.04, "meta": 0.06},
        "nonhuman": {"notification": 0.55, "peer": 0.45},
        "triggers_per_session": 0.0,
    },
    "life": {
        "items": "benchmarks/memory-life/fixture/memories.json",
        "start": "2025-04-01T07:00", "end": "2026-10-25T22:00", "sessions": 160, "weekdays": False,
        "hours": (7, 23), "scopes": False,
        "neg": {"task": 0.34, "ack": 0.15, "general": 0.12, "other": 0.10, "paste": 0.06, "restate": 0.07,
                "chitchat": 0.10, "meta": 0.06},
        "nonhuman": {"notification": 0.6, "peer": 0.4},
        "triggers_per_session": 0.3,
    },
}

NEED_TYPES = {  # share of need beats; `stale` needs an item that corrected an older one
    "direct": 0.18, "indirect": 0.24, "proactive": 0.26, "multi": 0.16, "stale": 0.16,
}


def quantile(rng, knots):
    u = rng.random()
    for (p0, v0), (p1, v1) in zip(knots, knots[1:]):
        if u <= p1:
            return max(1, round(v0 + (v1 - v0) * (u - p0) / (p1 - p0)))
    return knots[-1][1]


def parse(ts):
    return dt.datetime.fromisoformat(ts)


def session_times(rng, cfg):
    start, end = parse(cfg["start"]), parse(cfg["end"])
    span = (end - start).total_seconds()
    out = []
    while len(out) < cfg["sessions"]:
        if cfg["weekdays"]:
            u = rng.random()
        else:
            # Personal use grows: denser near the end (the last ten weeks hold about 40% of sessions).
            u = rng.random() ** 0.55
        t = start + dt.timedelta(seconds=u * span)
        if cfg["weekdays"] and t.weekday() >= 5 and rng.random() < 0.85:
            continue
        h0, h1 = cfg["hours"]
        t = t.replace(hour=rng.randint(h0, h1 - 1), minute=rng.randint(0, 59), second=0)
        out.append(t)
    return sorted(out)


def cluster_key(world, item):
    """Items that share a subject cluster (multi needs and grouped statements draw from one cluster)."""
    if world == "code":
        return item["scope"] or "root"
    s = item.get("subject") or item["text"]
    names = re.findall(r"\b[A-Z][a-z]+\b", item["text"])
    names = [n for n in names if n not in ("Riya", "The", "She", "He", "Since", "In", "On", "At", "Her")]
    return names[0] if names else s.split()[0]


def channel_of(world, item, rng):
    k = item["kind"]
    if world == "code":
        if k == "episode":
            return rng.choice(["user", "tool", "assistant"])
        if k in ("constraint", "preference", "procedure"):
            return "file" if (rng.random() < 0.15 and not item.get("superseded_by")) else "user"
        return rng.choices(["user", "tool", "assistant"], [0.5, 0.35, 0.15])[0]
    if k == "tool":
        return "tool"
    if k in ("plan", "commitment"):
        return rng.choices(["user", "tool"], [0.55, 0.45])[0]
    if k == "episode":
        return rng.choices(["user", "tool"], [0.7, 0.3])[0]
    return rng.choices(["user", "tool", "assistant"], [0.8, 0.12, 0.08])[0]


def build(world, seed):
    cfg = WORLDS[world]
    rng = random.Random(f"{world}-{seed}")
    items = json.load(open(os.path.join(ROOT, cfg["items"])))
    by = {x["id"]: x for x in items}
    pred = {x["superseded_by"]: x["id"] for x in items if x.get("superseded_by")}
    times = session_times(rng, cfg)
    n = len(times)
    sessions = []
    for i, t in enumerate(times):
        humans = quantile(rng, HUMAN_KNOTS)
        resume = i > 0 and (t - times[i - 1]).total_seconds() < 6 * 3600 and rng.random() < 0.5
        sessions.append({"id": f"{world}-s{i:03d}", "ts": t.isoformat(timespec="minutes"),
                         "kind": "resume" if resume else "startup",
                         "gap_days": round((t - times[i - 1]).total_seconds() / 86400, 2) if i else None,
                         "turns": [{"k": k, "beats": []} for k in range(humans)], "nonhuman": [], "triggers": []})

    # ---- first statements (intro) ----------------------------------------------------------------------------
    intro = {}
    order = sorted(items, key=lambda x: x.get("date") or "")
    for x in order:
        if world == "life":
            d = parse(x["date"] + "T00:00")
            cand = [i for i, t in enumerate(times) if t >= d]
            s = cand[min(len(cand) - 1, int(rng.random() ** 2 * min(4, len(cand))))] if cand else n - 1
        else:
            s = min(n - 1, int(rng.random() ** 1.6 * n * 0.85))
        intro[x["id"]] = s
    # A correction is stated after what it corrects; code migrations land in the middle third.
    for new, old in pred.items():
        if world == "code":
            intro[old] = min(intro[old], n // 4)
            intro[new] = max(intro[new], intro[old] + 3 + rng.randint(0, n // 3))
            intro[new] = min(intro[new], n - 12)
        elif intro[new] <= intro[old]:
            intro[new] = min(n - 1, intro[old] + 1)
    files = []
    for x in items:
        ch = channel_of(world, x, rng)
        if ch == "file":
            files.append(x["id"])
            continue
        s = sessions[intro[x["id"]]]
        group = None
        if ch in ("user", "tool"):
            for t in s["turns"]:
                for b in t["beats"]:
                    if b["type"] == "state" and b["channel"] == ch and len(b["items"]) < (2 if ch == "user" else 4):
                        if ch == "tool" or cluster_key(world, by[b["items"][0]]) == cluster_key(world, x):
                            group = b
        if group:
            group["items"].append(x["id"])
            continue
        free = [t for t in s["turns"] if not t["beats"]] or s["turns"]
        turn = rng.choice(free)
        beat = {"type": "state", "channel": ch, "items": [x["id"]]}
        if x["id"] in pred:
            beat["corrects"] = [pred[x["id"]]]
        turn["beats"].append(beat)

    # ---- need beats -------------------------------------------------------------------------------------------
    total_h = sum(len(s["turns"]) for s in sessions)
    target = round(NEED_RATE * total_h)
    clusters = {}
    for x in items:
        clusters.setdefault(cluster_key(world, x), []).append(x["id"])
    live = lambda iid, si: intro.get(iid, 0) < si and not (
        by[iid].get("superseded_by") and intro.get(by[iid]["superseded_by"], 10**9) < si)
    needed_count = {}
    made, tries = 0, 0
    while made < target and tries < 20000:
        tries += 1
        si = rng.randint(3, n - 1)
        free = [t for t in sessions[si]["turns"] if not t["beats"]]
        if not free:
            continue
        ntype = rng.choices(list(NEED_TYPES), list(NEED_TYPES.values()))[0]
        pool = [x["id"] for x in items if x["id"] not in files and live(x["id"], si)]
        if ntype == "stale":
            pool = [i for i in pool if i in pred]
        if not pool:
            continue
        # Prefer items needed less often (spread needs over the store), and some long lags.
        pool.sort(key=lambda i: (needed_count.get(i, 0), rng.random()))
        head = pool[: max(5, len(pool) // 3)]
        first = rng.choice(head)
        need = [first]
        if ntype == "multi":
            mates = [i for i in clusters[cluster_key(world, by[first])] if i != first and i in pool]
            if not mates:
                continue
            need += rng.sample(mates, min(len(mates), rng.choice([1, 1, 2])))
        for i in need:
            needed_count[i] = needed_count.get(i, 0) + 1
        beat = {"type": "need", "need_type": ntype, "items": need}
        if ntype == "stale":
            beat["forbidden"] = [pred[first]]
        if ntype == "proactive" and rng.random() < 0.4:
            beat["action"] = True  # the agent acts on the request in this turn; that tool call needs the items too
        rng.choice(free)["beats"].append(beat)
        made += 1

    # ---- triggers (time, calendar, incoming message, returning user): life world --------------------------------
    for si, s in enumerate(sessions):
        if rng.random() >= cfg["triggers_per_session"] or si < 3:
            continue
        kind = rng.choice(["time", "calendar", "message", "calendar"])
        beat = {"type": "trigger", "trigger": kind, "items": []}
        pool = [x["id"] for x in items if x["id"] not in files and live(x["id"], si)
                and x["kind"] in ("person", "preference", "plan", "commitment", "routine", "instruction", "fact")]
        if pool and rng.random() < 0.6:
            first = rng.choice(pool)
            beat["items"] = [first]
            beat["need_type"] = "event"
        s["triggers"].append({"after": rng.randint(-1, len(s["turns"]) - 1), "beat": beat})

    # ---- negatives and plain turns ------------------------------------------------------------------------------
    negw = cfg["neg"]
    for s in sessions:
        stated = []
        for t in s["turns"]:
            if not t["beats"]:
                kind = rng.choices(list(negw), list(negw.values()))[0]
                if kind == "restate":
                    kind = "restate" if stated else "task"
                beat = {"type": "neg", "neg": kind}
                if kind == "restate":
                    beat["items"] = [rng.choice(stated)]
                if t["k"] == 0 and kind == "ack":
                    beat["neg"] = "task"
                t["beats"].append(beat)
            for b in t["beats"]:
                if b["type"] == "state" and b["channel"] == "user":
                    stated += b["items"]
        humans = len(s["turns"])
        nh = sum(1 for _ in range(humans * 4) if rng.random() < NONHUMAN_PER_HUMAN / 4)
        for _ in range(nh):
            kind = rng.choices(list(cfg["nonhuman"]), list(cfg["nonhuman"].values()))[0]
            s["nonhuman"].append({"after": rng.randint(0, humans - 1), "kind": kind})
        s["nonhuman"].sort(key=lambda e: e["after"])
        if humans >= 7 and rng.random() < 0.6:
            s["compact_after"] = rng.randint(humans // 2, humans - 2)
    return {
        "world": world, "seed": seed, "author": "plan.py (deterministic)",
        "config": {k: v for k, v in cfg.items() if k != "items"} | {"items": cfg["items"], "need_rate": NEED_RATE},
        "files": files, "intro": intro, "sessions": sessions,
    }


def stats(plan):
    ss = plan["sessions"]
    h = sum(len(s["turns"]) for s in ss)
    need = sum(1 for s in ss for t in s["turns"] if any(b["type"] == "need" for b in t["beats"]))
    nh = sum(len(s["nonhuman"]) for s in ss)
    trig = sum(len(s["triggers"]) for s in ss)
    trig_need = sum(1 for s in ss for t in s["triggers"] if t["beat"]["items"])
    nt = {}
    for s in ss:
        for t in s["turns"]:
            for b in t["beats"]:
                key = b.get("need_type") or b.get("neg") or f"state:{b.get('channel')}"
                nt[key] = nt.get(key, 0) + 1
    return {"sessions": len(ss), "human": h, "need_turns": need, "need_rate": round(need / h, 3), "nonhuman": nh,
            "nonhuman_share": round(nh / (nh + h + trig), 3), "triggers": trig, "trigger_needs": trig_need,
            "files": len(plan["files"]), "beats": dict(sorted(nt.items()))}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True, choices=list(WORLDS))
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    plan = build(a.world, a.seed)
    out = os.path.join(HERE, "worlds", a.world, "plan.json")
    json.dump(plan, open(out, "w"), indent=1)
    print(json.dumps(stats(plan), indent=1))
