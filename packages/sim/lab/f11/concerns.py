"""F11: the control and neutral answers a run's grader marked as raising a concern, for a second, careful grade
(CLAUDE.md: read and regrade concerns before acting on a difference; the subagent grader of D1101 flags answers that
state no concern). Lab tooling.

    python3 -I packages/sim/lab/f11/concerns.py dump OUT.json STEM [STEM …]   # flagged answers, one row each
    python3 -I packages/sim/lab/f11/concerns.py count VERDICTS.json             # confirmed concerns by arm

A verdicts file is [{"key", "claims": true|false, "why"}]: claims is true only if the answer itself asserts the
concern (as a fact, a warning or a reason to change plan).
"""
import collections
import json
import sys


def dump(out, stems):
    rows = []
    for stem in stems:
        r = json.load(open(stem + ".json"))
        tasks = {t["id"]: t for t in r["tasks"]}
        for x in r["results"]:
            t = tasks.get(x["task"])
            if not t or t["kind"] == "hidden" or x.get("error") or not x.get("facts"):
                continue
            if not any(x["facts"].values()):
                continue
            rows.append(
                {
                    "key": f"{stem.rsplit('/', 1)[-1]}|{x['condition']}|{x['task']}",
                    "arm": x["condition"],
                    "kind": t["kind"],
                    "request": t["text"],
                    "concern": t["must"][0]["detail"],
                    "answer": x.get("answer", ""),
                }
            )
    json.dump(rows, open(out, "w"), indent=1, ensure_ascii=False)
    print(f"{len(rows)} flagged answers -> {out}")


def count(path):
    v = json.load(open(path))
    by = collections.Counter()
    for x in v:
        arm = x["key"].split("|")[1]
        by[(arm, bool(x["claims"]))] += 1
    for arm in sorted({a for a, _ in by}):
        print(f"{arm}: confirmed {by[(arm, True)]}, not confirmed {by[(arm, False)]}")


if sys.argv[1] == "dump":
    dump(sys.argv[2], sys.argv[3:])
else:
    count(sys.argv[2])
