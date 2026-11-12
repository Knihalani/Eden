"""F6 (docs/research/f6-uptake.md): uptake and the pre-registered rule, from pi-ab results and timelines.

    python3 -I packages/sim/lab/f6/report.py BASE_ARM RUN_STEM...   (each STEM has STEM.json and STEM.tl/tasks.jsonl)

Per arm: hidden raised, uptake P(raised | planted in a pushed packet), raised when only an ask cited it, concerns on
control and neutral (Sonnet is the in-run grader), packets a task and bytes a packet, tool calls a task, agent and
Eden $ a 1,000 tasks. Each arm against BASE_ARM: differences with a 95% bootstrap clustered by template (the same
template's tasks over seeds and variants resampled together; 2,000 resamples, seed 7).
"""

import ast
import collections
import json
import random
import sys


def load(stems):
    res, tl = {}, {}
    for stem in stems:
        for r in json.load(open(stem + ".json"))["results"]:
            res[(r["task"], r["condition"])] = r
        for line in open(stem + ".tl/tasks.jsonl"):
            t = json.loads(line)
            tl[(t["task"], t["condition"])] = t
    return res, tl


def ids(v):
    if isinstance(v, str):
        v = ast.literal_eval(v)
    return v or []


def rows(res, tl):
    out = []
    for (task, cond), r in res.items():
        seed, suite, tmpl = task.split(":")[:3]
        kind = "hidden" if "-" not in suite else suite.split("-", 1)[1]
        t = tl.get((task, cond), {})
        planted = t.get("planted")
        packets = t.get("packets") or ""
        out.append(
            dict(
                cond=cond,
                kind=kind,
                tmpl=f"{suite.split('-')[0]}:{tmpl}",
                task=f"{seed}:{suite.split('-')[0]}:{tmpl}:{kind}",
                flag=any(r["facts"].values()),
                pushed=bool(planted) and planted in ids(t.get("cited")),
                asked=bool(planted) and planted in ids(t.get("askCited")),
                npackets=packets.count("<context "),
                bytes=len(packets.encode()),
                tools=r.get("toolCalls", 0),
                usd=(r.get("agentCostUsd", 0) or 0) + (r.get("edenCostUsd", 0) or 0),
                graded=r.get("graded", True),
            )
        )
    return out


def stats(xs):
    h = [x for x in xs if x["kind"] == "hidden"]
    pushed = [x for x in h if x["pushed"]]
    askonly = [x for x in h if x["asked"] and not x["pushed"]]
    cn = [x for x in xs if x["kind"] != "hidden"]
    pk = [x for x in xs if x["npackets"] > 0]
    return dict(
        n=len(xs),
        hidden=(sum(x["flag"] for x in h), len(h)),
        uptake=(sum(x["flag"] for x in pushed), len(pushed)),
        askonly=(sum(x["flag"] for x in askonly), len(askonly)),
        concerns=(sum(x["flag"] for x in cn), len(cn)),
        neutral_packets=(sum(x["npackets"] > 0 for x in xs if x["kind"] == "neutral"),
                         sum(1 for x in xs if x["kind"] == "neutral")),
        bytes_per_packet=sum(x["bytes"] for x in pk) / max(1, sum(x["npackets"] for x in pk)),
        tools=sum(x["tools"] for x in xs) / max(1, len(xs)),
        usd_1k=1000 * sum(x["usd"] for x in xs) / max(1, len(xs)),
    )


def rate(p):
    return p[0] / p[1] if p[1] else float("nan")


def boot(base, arm, f, n=2000):
    """f(rows) -> number; arm minus base, resampling templates (shared by both arms)."""
    by = collections.defaultdict(lambda: ([], []))
    for x in base:
        by[x["tmpl"]][0].append(x)
    for x in arm:
        by[x["tmpl"]][1].append(x)
    keys = sorted(by)
    rnd = random.Random(7)
    point = f(arm) - f(base)
    ds = []
    for _ in range(n):
        b, a = [], []
        for k in rnd.choices(keys, k=len(keys)):
            b += by[k][0]
            a += by[k][1]
        ds.append(f(a) - f(b))
    ds.sort()
    return point, ds[int(0.025 * n)], ds[int(0.975 * n) - 1]


def main():
    base_arm, stems = sys.argv[1], sys.argv[2:]
    res, tl = load(stems)
    rs = rows(res, tl)
    # Pair on tasks every arm finished.
    by_task = collections.defaultdict(set)
    for x in rs:
        by_task[x["task"]].add(x["cond"])
    arms = sorted({x["cond"] for x in rs})
    done = {t for t, c in by_task.items() if c >= set(arms)}
    rs = [x for x in rs if x["task"] in done]
    print(f"tasks finished in every arm: {len(done)}")
    S = {a: stats([x for x in rs if x["cond"] == a]) for a in arms}
    for a in arms:
        s = S[a]
        print(
            f"{a:22} hidden {s['hidden'][0]}/{s['hidden'][1]} ({rate(s['hidden']):.1%})  uptake {s['uptake'][0]}/"
            f"{s['uptake'][1]} ({rate(s['uptake']):.1%})  ask-only {s['askonly'][0]}/{s['askonly'][1]}  concerns "
            f"{s['concerns'][0]}/{s['concerns'][1]}  neutral packets {s['neutral_packets'][0]}/"
            f"{s['neutral_packets'][1]}  B/packet {s['bytes_per_packet']:.0f}  tools {s['tools']:.2f}  "
            f"$/1k {s['usd_1k']:.3f}"
        )
    base = [x for x in rs if x["cond"] == base_arm]

    def hid(xs):
        h = [x for x in xs if x["kind"] == "hidden"]
        return 100 * sum(x["flag"] for x in h) / max(1, len(h))

    def upt(xs):
        h = [x for x in xs if x["kind"] == "hidden" and x["pushed"]]
        return 100 * sum(x["flag"] for x in h) / max(1, len(h))

    def con(xs):
        return sum(x["flag"] for x in xs if x["kind"] != "hidden")

    def bpp(xs):
        pk = [x for x in xs if x["npackets"] > 0]
        return sum(x["bytes"] for x in pk) / max(1, sum(x["npackets"] for x in pk))

    for a in arms:
        if a == base_arm:
            continue
        arm = [x for x in rs if x["cond"] == a]
        u = boot(base, arm, upt)
        h = boot(base, arm, hid)
        c = con(arm) - con(base)
        b = 100 * (bpp(arm) / max(1e-9, bpp(base)) - 1)
        ok = u[1] > 0 and h[0] >= 0 and c <= 0 and b <= 10
        print(
            f"{a} vs {base_arm}: uptake {u[0]:+.1f} ({u[1]:+.1f}..{u[2]:+.1f}) points; hidden {h[0]:+.1f} "
            f"({h[1]:+.1f}..{h[2]:+.1f}); concerns {c:+d}; bytes/packet {b:+.1f}%  => "
            f"{'PASSES' if ok else 'fails'} the rule"
        )


main()
