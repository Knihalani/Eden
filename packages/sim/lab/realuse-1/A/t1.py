"""RealUse-1 part A: the T1 metrics of docs/research/benchmark-realuse-1.md from pi-ab.ts results files.

  python3 -I t1.py OUT.json LEDGER.jsonl PROFILE=run1.json,run2.json [PROFILE=...]

Reads each results file with its timeline (`<timeline>/tasks.jsonl`) and writes a compact JSON summary (no answers,
no transcripts) and prints it as tables. Per profile, condition and task kind (hidden, control, neutral):

- rate: hidden facts raised (hidden), false concerns (control), any concern (neutral), as the grader read them;
- wall p50, p90, mean (s); Eden on the critical path: the union of Eden's spans the agent waits on (the observe and
  reader spans on the path lane, and every ask_context call), in ms and as a share of the task's wall time;
- agent tokens per task (fresh input, cache read, cache write, output) and the agent's $ as billed;
- Eden's $ per task: per-task calls (the reader) as billed, plus the stream's background spend (cards) spread over
  its tasks (`bkfill`, as pi-ab-report.ts spreads it);
- connector calls per task: the agent's searches, Eden's by kind (search, list, fetch);
- reader calls, packets and packet bytes per task (Eden's injections as the agent saw them).

Paired bootstrap 95% intervals (4,000 resamples over tasks, seed 7) on differences: tools vs eden, tools vs both,
eden vs both within a profile, and direct vs hosted for one condition. The traffic-weighted figure mixes 1 hidden,
1 control and 8 neutral tasks in 10 (an assumption): means weighted by share, p50/p90 from the pooled weighted samples,
and its intervals resample each kind's pairs on their own. The ledger gives Eden's and the run's $ by role per run label.
"""

import json
import os
import random
import statistics
import sys

KINDS = ("hidden", "control", "neutral")
MIX = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}


def union_ms(spans):
    total, end = 0.0, None
    for a, b in sorted(spans):
        if end is None or a > end:
            total += b - a
            end = b
        elif b > end:
            total += b - end
            end = b
    return total


def spans(events):
    """Closed spans (name, start, end, lane, data of the begin event) from B/E event pairs."""
    open_, out = {}, []
    for e in events:
        if e.get("ph") == "B":
            open_[e.get("id")] = e
        elif e.get("ph") == "E" and e.get("id") in open_:
            b = open_.pop(e["id"])
            out.append((b["ev"], b["t"], e["t"], b.get("lane"), b.get("data") or {}))
    return out


def task_row(r, t, bkfill):
    sp = spans(t["events"])
    path = [(a, b) for (ev, a, b, lane, _) in sp if ev.startswith("eden.") and lane == "path"]
    asks = [(a, b) for (ev, a, b, _, _) in sp if ev == "eden.ask"]
    eden_path = union_ms(path + asks)
    req = t.get("requests") or []
    cached = sum(q.get("cached", 0) for q in req)
    write = sum(q.get("cacheWrite", 0) for q in req)
    tin = sum(q["in"] for q in req)
    src = {"search": 0, "list": 0, "fetch": 0}
    for ev, _, _, _, data in sp:
        if ev == "eden.source":
            op = data.get("op")
            src[op] = src.get(op, 0) + 1
    injects = [e for e in t["events"] if e.get("ev") == "eden.inject" and e.get("ph") == "I"]
    must = r["_must"]
    rate = sum(1 for m in must if (r.get("facts") or {}).get(m["id"])) / max(1, len(must))
    wall = r["wallMs"] / 1000
    return {
        "rate": rate,
        "wall": wall,
        "edenPathMs": eden_path,
        "edenPathShare": eden_path / max(1.0, r["wallMs"]),
        "inFresh": tin - cached - write,
        "cacheRead": cached,
        "cacheWrite": write,
        "out": sum(q["out"] for q in req),
        "agentUsd": r["costUsd"],
        "edenTaskUsd": r.get("edenCostUsd", 0),
        "edenBgUsd": bkfill,
        "allInUsd": r["costUsd"] + r.get("edenCostUsd", 0) + bkfill,
        "agentCalls": r["toolCalls"],
        "edenSearch": src.get("search", 0),
        "edenList": src.get("list", 0),
        "edenFetch": src.get("fetch", 0),
        "connectorCalls": r["toolCalls"] + sum(src.values()),
        "readerCalls": sum(1 for (ev, *_rest) in sp if ev == "eden.reader"),
        "packets": len(injects),
        "packetBytes": sum((e.get("data") or {}).get("chars", 0) for e in injects),
    }


def load(paths):
    """Rows keyed (condition, task id) -> (kind, row); and the run labels' metadata."""
    rows, meta = {}, []
    for p in paths:
        d = json.load(open(p))
        tasks = {t["id"]: t for t in d["tasks"]}
        bg = {}
        for b in d.get("background") or []:
            n = max(1, len(b["tasks"]))
            for tid in b["tasks"]:
                bg[(b["condition"], tid)] = (b["cardsUsd"] + b["bridgeUsd"]) / n
        tl = os.path.join(d.get("timeline") or p[: -len(".json")], "tasks.jsonl")
        lines = {}
        for line in open(tl):
            t = json.loads(line)
            lines[(t["condition"], t["task"])] = t
        errors = 0
        for r in d["results"]:
            key = (r["condition"], r["task"])
            t = lines.get(key)
            if t is None or r.get("error"):
                errors += 1
                continue
            r = dict(r, _must=tasks[r["task"]]["must"])
            rows[key] = (tasks[r["task"]]["kind"], task_row(r, t, bg.get(key, 0.0)))
        meta.append(
            {
                "file": os.path.basename(p),
                "seeds": d.get("seeds"),
                "spent": d.get("spent"),
                "spend": d.get("spend"),
                "overBudget": d.get("overBudget"),
                "intent": d.get("intent"),
                "errors": errors,
                "wallSeconds": d.get("wallSeconds"),
            }
        )
    return rows, meta


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None


def wq(pairs, p):
    """Weighted quantile: smallest value whose cumulative weight reaches p."""
    pairs = sorted(x for x in pairs if x[1] > 0)
    tot = sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w / tot
        if acc >= p - 1e-12:
            return v
    return pairs[-1][0] if pairs else None


def mean(xs):
    return statistics.mean(xs) if xs else None


FIELDS = (
    "rate",
    "inFresh",
    "cacheRead",
    "cacheWrite",
    "out",
    "agentUsd",
    "edenTaskUsd",
    "edenBgUsd",
    "allInUsd",
    "agentCalls",
    "edenSearch",
    "edenList",
    "edenFetch",
    "connectorCalls",
    "readerCalls",
    "packets",
    "packetBytes",
    "edenPathMs",
    "edenPathShare",
)


def summarise(rs):
    out = {"n": len(rs)}
    for f in FIELDS:
        out[f] = mean([r[f] for r in rs])
    walls = [r["wall"] for r in rs]
    out.update(wallP50=q(walls, 0.5), wallP90=q(walls, 0.9), wallMean=mean(walls))
    out["perK"] = 1000 * out["allInUsd"] if rs else None
    return out


def boot(diffs, n=4000, seed=7):
    if not diffs:
        return None
    rng = random.Random(seed)
    m = sorted(statistics.mean(rng.choices(diffs, k=len(diffs))) for _ in range(n))
    return [statistics.mean(diffs), m[int(0.025 * n)], m[int(0.975 * n)]]


DIFF = (("rate", 1), ("wall", 1), ("allInUsd", 1000), ("connectorCalls", 1), ("edenPathMs", 1))


def paired(a_rows, b_rows):
    """a − b per kind over tasks both have; and the traffic-weighted difference (each kind resampled on its own)."""
    out = {}
    for kind in KINDS:
        ids = sorted(t for (k, t) in a_rows if k == kind and (k, t) in b_rows)
        if not ids:
            continue
        out[kind] = {"n": len(ids)}
        for f, scale in DIFF:
            out[kind][f] = boot([scale * (a_rows[(kind, i)][f] - b_rows[(kind, i)][f]) for i in ids])
    if all(k in out for k in KINDS):
        rng = random.Random(11)
        per = {
            k: sorted(t for (kk, t) in a_rows if kk == k and (kk, t) in b_rows)
            for k in KINDS
        }
        out["mix"] = {}
        for f, scale in DIFF + (("wrong", 1),):
            def val(rows, k, i):
                if f == "wrong":
                    return rows[(k, i)]["rate"] if k != "hidden" else 0.0
                if f == "rate":
                    return rows[(k, i)]["rate"] if k == "hidden" else 0.0
                return rows[(k, i)][f]

            point = sum(
                MIX[k] * statistics.mean(scale * (val(a_rows, k, i) - val(b_rows, k, i)) for i in per[k])
                for k in KINDS
            )
            draws = []
            for _ in range(4000):
                draws.append(
                    sum(
                        MIX[k]
                        * statistics.mean(
                            scale * (val(a_rows, k, i) - val(b_rows, k, i)) for i in rng.choices(per[k], k=len(per[k]))
                        )
                        for k in KINDS
                    )
                )
            draws.sort()
            out["mix"][f if f != "rate" else "raised"] = [point, draws[100], draws[3899]]
    return out


def mix_row(by_kind):
    if not all(by_kind.get(k) for k in KINDS):
        return None
    pooled = [(r["wall"], MIX[k] / len(by_kind[k])) for k in KINDS for r in by_kind[k]]
    m = lambda f: sum(MIX[k] * statistics.mean(r[f] for r in by_kind[k]) for k in KINDS)  # noqa: E731
    return {
        "raised": MIX["hidden"] * statistics.mean(r["rate"] for r in by_kind["hidden"]),
        "wrongConcern": sum(MIX[k] * statistics.mean(r["rate"] for r in by_kind[k]) for k in ("control", "neutral")),
        "perK": 1000 * m("allInUsd"),
        "edenPerK": 1000 * (m("edenTaskUsd") + m("edenBgUsd")),
        "wallMean": m("wall"),
        "wallP50": wq(pooled, 0.5),
        "wallP90": wq(pooled, 0.9),
        "connectorCalls": m("connectorCalls"),
        "readerCalls": m("readerCalls"),
        "packetBytes": m("packetBytes"),
        "edenPathShare": m("edenPathShare"),
    }


def ledger_by_role(path, labels):
    out = {}
    for line in open(path):
        x = json.loads(line)
        run = x.get("run", "")
        if not any(run == lab or run.startswith(lab) for lab in labels):
            continue
        cell = out.setdefault(run, {})
        role = x.get("role", "?")
        c = cell.setdefault(role, {"calls": 0, "usd": 0.0})
        c["calls"] += 1
        c["usd"] += x.get("costUsd", 0.0)
    return out


def main():
    out_path, ledger, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
    profiles, meta = {}, {}
    for spec in specs:
        name, files = spec.split("=", 1)
        profiles[name], meta[name] = load(files.split(","))
    summary = {"mix": MIX, "profiles": {}, "pairs": {}, "meta": meta}
    for name, rows in profiles.items():
        conds = sorted({c for (c, _) in rows})
        cell = summary["profiles"][name] = {}
        for c in conds:
            by_kind = {k: [row for (cc, _), (kk, row) in rows.items() if cc == c and kk == k] for k in KINDS}
            cell[c] = {k: summarise(v) for k, v in by_kind.items() if v}
            mr = mix_row(by_kind)
            if mr:
                cell[c]["mix"] = mr
        keyed = {c: {(k, t): row for (cc, t), (k, row) in rows.items() if cc == c} for c in conds}
        for a, b in (("eden", "tools"), ("both", "tools"), ("both", "eden")):
            if a in keyed and b in keyed:
                summary["pairs"][f"{name}: {a} - {b}"] = paired(keyed[a], keyed[b])
    if "direct" in profiles and "hosted" in profiles:
        for c in ("tools", "eden"):
            ka = {(k, t): row for (cc, t), (k, row) in profiles["direct"].items() if cc == c}
            kb = {(k, t): row for (cc, t), (k, row) in profiles["hosted"].items() if cc == c}
            summary["pairs"][f"{c}: direct - hosted"] = paired(ka, kb)
    labels = [m["file"][: -len(".json")] for ms in meta.values() for m in ms]
    summary["ledger"] = ledger_by_role(ledger, labels)
    json.dump(summary, open(out_path, "w"), indent=1, sort_keys=True)
    show(summary)


def fmt(x, d=3):
    return "-" if x is None else f"{x:.{d}f}"


def ci(v, d=3):
    return "-" if not v else f"{v[0]:+.{d}f} ({v[1]:+.{d}f}..{v[2]:+.{d}f})"


def show(s):
    for name, conds in s["profiles"].items():
        print(f"\n## {name}")
        print(
            "cond  kind     n   rate  p50s  p90s meanS edenPathMs share  inFresh cRead cWrite  out  agent$/1k "
            "edenTask$/1k bkfill$/1k allIn$/1k agentCalls eSearch eList eFetch reader packets bytes"
        )
        for c, kinds in conds.items():
            for k in KINDS:
                r = kinds.get(k)
                if not r:
                    continue
                print(
                    f"{c:5} {k:8} {r['n']:3} {fmt(r['rate'])} {fmt(r['wallP50'], 2)} {fmt(r['wallP90'], 2)} "
                    f"{fmt(r['wallMean'], 2)} {fmt(r['edenPathMs'], 0):>6} {fmt(r['edenPathShare'])} "
                    f"{fmt(r['inFresh'], 0):>6} {fmt(r['cacheRead'], 0):>5} {fmt(r['cacheWrite'], 0):>5} "
                    f"{fmt(r['out'], 0):>4} {fmt(1000 * r['agentUsd']):>7} {fmt(1000 * r['edenTaskUsd']):>7} "
                    f"{fmt(1000 * r['edenBgUsd']):>7} {fmt(r['perK']):>7} {fmt(r['agentCalls'], 2)} "
                    f"{fmt(r['edenSearch'], 2)} {fmt(r['edenList'], 2)} {fmt(r['edenFetch'], 2)} "
                    f"{fmt(r['readerCalls'], 2)} {fmt(r['packets'], 2)} {fmt(r['packetBytes'], 0)}"
                )
            m = kinds.get("mix")
            if m:
                print(
                    f"{c:5} MIX 1:1:8 raised {fmt(m['raised'])} wrong {fmt(m['wrongConcern'])} $/1k {fmt(m['perK'])} "
                    f"(Eden {fmt(m['edenPerK'])}) wall p50 {fmt(m['wallP50'], 2)} p90 {fmt(m['wallP90'], 2)} "
                    f"mean {fmt(m['wallMean'], 2)} calls {fmt(m['connectorCalls'], 2)} "
                    f"edenPathShare {fmt(m['edenPathShare'])}"
                )
    print("\n## paired differences a − b, bootstrap 95%")
    for pair, kinds in s["pairs"].items():
        for k, v in kinds.items():
            if k == "mix":
                print(
                    f"{pair:24} MIX    raised {ci(v['raised'])} wrong {ci(v['wrong'])} wall {ci(v['wall'], 2)} "
                    f"$/1k {ci(v['allInUsd'])} calls {ci(v['connectorCalls'], 2)}"
                )
            else:
                print(
                    f"{pair:24} {k:7} n={v['n']:3} rate {ci(v['rate'])} wall {ci(v['wall'], 2)} "
                    f"$/1k {ci(v['allInUsd'])} calls {ci(v['connectorCalls'], 2)} edenPathMs {ci(v['edenPathMs'], 0)}"
                )


if __name__ == "__main__":
    main()
