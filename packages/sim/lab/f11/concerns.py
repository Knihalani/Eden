"""F11: the control and neutral answers a run's grader marked as raising a concern, for a second, careful grade
(CLAUDE.md: read and regrade concerns before acting on a difference; the subagent grader of D1101 flags answers that
state no concern). Lab tooling.

    python3 -I packages/sim/lab/f11/concerns.py dump OUT.json STEM [STEM …]   # flagged answers, one row each
    python3 -I packages/sim/lab/f11/concerns.py dump-all OUT.json STEM [STEM …] [--arms A,B]  # every control and
                                                                                 # neutral answer (hedge counts)
    python3 -I packages/sim/lab/f11/concerns.py count VERDICTS.json             # confirmed concerns by arm

A verdicts file is [{"key", "claims": true|false, "why"}]: claims is true only if the answer itself asserts the
concern (as a fact, a warning or a reason to change plan).
"""
import collections
import json
import sys


def dump(out, stems, every=False, arms=None):
    rows = []
    for stem in stems:
        r = json.load(open(stem + ".json"))
        tasks = {t["id"]: t for t in r["tasks"]}
        for x in r["results"]:
            t = tasks.get(x["task"])
            if not t or t["kind"] == "hidden" or x.get("error") or not x.get("facts"):
                continue
            if not every and not any(x["facts"].values()):
                continue
            if arms and x["condition"] not in arms:
                continue
            rows.append(
                {
                    "key": f"{stem.rsplit('/', 1)[-1]}|{x['condition']}|{x['task']}",
                    "arm": x["condition"],
                    "kind": t["kind"],
                    "request": t["text"],
                    "concern": t["must"][0]["detail"],
                    "answer": x.get("answer", ""),
                    "graded": any(x["facts"].values()),
                }
            )
    json.dump(rows, open(out, "w"), indent=1, ensure_ascii=False)
    print(f"{len(rows)} flagged answers -> {out}")


def count(path):
    v = json.load(open(path))
    by = collections.Counter()
    keys = ("claims", "specific", "hedge")
    arms = sorted({x["key"].split("|")[1] for x in v})
    for arm in arms:
        rows = [x for x in v if x["key"].split("|")[1] == arm]
        parts = [f"{k} {sum(1 for x in rows if x.get(k))}" for k in keys if any(k in x for x in rows)]
        print(f"{arm}: {len(rows)} answers; " + ", ".join(parts))


if sys.argv[1] in ("dump", "dump-all"):
    rest = sys.argv[3:]
    arms = None
    if "--arms" in rest:
        i = rest.index("--arms")
        arms = set(rest[i + 1].split(","))
        rest = rest[:i] + rest[i + 2 :]
    dump(sys.argv[2], rest, every=sys.argv[1] == "dump-all", arms=arms)
else:
    count(sys.argv[2])
