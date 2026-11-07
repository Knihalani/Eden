"""fix-w2b: attribute every false (control) and neutral concern of pi-ab runs to the way the agent got it.

python3 -I attribute.py OUT.json RUN.json [RUN.json ...] [--condition eden] [--regrade REGRADE.json ...]

Each RUN.json is a pi-ab results file whose timeline (RUN.timeline/tasks.jsonl) holds the per-task records (`ways`,
`cited`, `askCited`, `asks[].text`). A concern is a control task whose fact the grader called true, or a neutral task
with any fact true. Its planted item (control: the decoy) is attributed, first match wins:

  push-flagged    a packet whose reason is `reader` (the reader push: items the reader flagged) cited it
  rule-path       another proactive packet cited it (grounded-*, fallback, sources, cache, ...)
  ask-flagged     an ask answer cited it on a line that carries "Eden's reader:" (the reader flagged it)
  ask-listed      an ask answer cited it with no reader note (listed only)
  none            no Eden packet or answer cited it

Neutral tasks plant nothing: they are listed with what reached the agent, for reading by hand. With --regrade, a
regrade.ts output's verdicts are joined, and a concern the regrader does not call true is marked `grader?`.
"""
import json
import os
import sys


def lines_of(answer):
    # Rendered answer lines in citation order: "- [source] ..." (renderPacket), one per item shown.
    return [l for l in (answer or "").split("\n") if l.startswith("- [")]


def ask_way(rec, item):
    for a in rec.get("asks") or []:
        if item in a["cited"]:
            ls = lines_of(a.get("text", ""))
            k = a["cited"].index(item)
            if k < len(ls) and "Eden's reader:" in ls[k]:
                return "ask-flagged"
            return "ask-listed"
    if item in (rec.get("askCited") or []):
        return "ask-listed"
    return None


def all_ways(rec, item):
    """Every way the item reached the agent, in the attribution order."""
    out = []
    for w in rec.get("ways") or []:
        if item in w["ids"]:
            k = "push-flagged" if w["why"] == "reader" else "rule-path:" + w["why"]
            if k not in out:
                out.append(k)
    if not out and item in (rec.get("cited") or []):
        out.append("rule-path:?")
    for a in rec.get("asks") or []:
        if item in a["cited"]:
            ls = lines_of(a.get("text", ""))
            k = a["cited"].index(item)
            v = "ask-flagged" if k < len(ls) and "Eden's reader:" in ls[k] else "ask-listed"
            if v not in out:
                out.append(v)
    return out


def way(rec, item):
    w = all_ways(rec, item)
    return w[0].split(":")[0] if w else "none"


def main():
    args = sys.argv[1:]
    cond = "eden"
    regrades = []
    runs = []
    out = args.pop(0)
    while args:
        a = args.pop(0)
        if a == "--condition":
            cond = args.pop(0)
        elif a == "--regrade":
            regrades.append(args.pop(0))
        else:
            runs.append(a)
    regraded = {}
    for f in regrades:
        for g in json.load(open(f)).get("graded", []):
            if g.get("facts") is not None:
                regraded[(g["task"], g["condition"])] = any(g["facts"].values())
    rows = []
    totals = {}
    for f in runs:
        run = json.load(open(f))
        tasks = {t["id"]: t for t in run["tasks"]}
        tl = run.get("timeline") or f.replace(".json", ".timeline")
        recs = {}
        path = os.path.join(tl, "tasks.jsonl")
        if os.path.exists(path):
            for l in open(path):
                r = json.loads(l)
                recs[(r["task"], r["condition"])] = r
        for r in run["results"]:
            if r["condition"] != cond and not r["condition"].startswith(cond + "|"):
                continue
            t = tasks.get(r["task"])
            if not t or t["kind"] not in ("control", "neutral") or r.get("error") or r.get("facts") is None:
                continue
            key = (t["suite"] if "suite" in t else f, t["kind"])
            totals[key] = totals.get(key, 0) + 1
            if not any(r["facts"].values()):
                continue
            rec = recs.get((r["task"], r["condition"]), {})
            planted = rec.get("planted") or t.get("planted")
            w = way(rec, planted) if (planted and t["kind"] == "control") else "neutral"
            row = {
                "file": os.path.basename(f),
                "task": r["task"],
                "kind": t["kind"],
                "suite": t.get("suite"),
                "way": w,
                "allWays": all_ways(rec, planted) if (planted and t["kind"] == "control") else [],
                "regrade": regraded.get((r["task"], r["condition"])),
                "planted": planted,
                "must": [m["detail"] for m in t["must"]],
                "request": t["text"][:300],
                "answer": r["answer"][:1500],
                "ways": rec.get("ways"),
                "asks": [
                    {"q": a["question"][:200], "cited": a["cited"], "text": a.get("text", "")[:1500]}
                    for a in rec.get("asks") or []
                ],
                "packets": (rec.get("packets") or "")[:1500],
            }
            rows.append(row)
    summary = {}
    for row in rows:
        k = row["kind"]
        summary.setdefault(k, {})
        summary[k][row["way"]] = summary[k].get(row["way"], 0) + 1
    n = {}
    for (s, k), v in totals.items():
        n[k] = n.get(k, 0) + v
    json.dump({"n": n, "summary": summary, "rows": rows}, open(out, "w"), indent=1)
    print(json.dumps({"n": n, "summary": summary}))


main()
