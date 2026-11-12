"""F2 (docs/research/f2-push-recall.md): another reading of recorded compare-first replies, at $0.

    python3 -I offline.py DUMP.jsonl ...

W is the shipped parse (`hits` not none and `act` true); H hands every item whose point lands on the request
(`hits` not none), whatever its verdict. Per task (the union of its checks): planted named on hidden tasks,
look-alike named on control tasks, neutral tasks with any item named.
"""
import collections
import json
import re
import sys

NO_HIT = re.compile(r"^\s*(?:(?:none|n/a)(?!\w).*|(?:nothing|no)?\s*\.?\s*)$", re.I | re.S)


def named(r, arm):
    try:
        rep = r["reply"]
        ents = json.loads(rep[rep.index("{"):rep.rindex("}") + 1])["items"]
    except Exception:
        return None
    out = []
    for x in ents[:12]:
        try:
            i = int(x.get("i"))
        except Exception:
            continue
        if not 1 <= i <= len(r["items"]):
            continue
        landed = isinstance(x.get("hits"), str) and not NO_HIT.match(x["hits"])
        keep = landed and (x.get("act") in (True, "true") or arm == "H")
        if keep and r["items"][i - 1]["id"] not in out and len(out) < 5:
            out.append(r["items"][i - 1]["id"])
    return out


def main():
    rows = [json.loads(line) for f in sys.argv[1:] for line in open(f) if line.strip()]
    rows = [r for r in rows if r["yes"] is not None]
    planted = {(r["suite"], r["seed"], r["template"], r["variant"]): r["planted"] for r in rows}
    for arm in ("W", "H"):
        task = collections.defaultdict(set)
        for r in rows:
            got = named(r, arm)
            task[(r["suite"], r["seed"], r["template"], r["variant"])] |= set(got or [])
        kind = lambda v: [k for k in task if k[3] == v]  # noqa: E731
        p = sum(planted[k] in task[k] for k in kind("hidden"))
        d = sum(planted[k] in task[k] for k in kind("control"))
        n = sum(bool(task[k]) for k in kind("neutral"))
        print(f"{arm}: planted {p}/{len(kind('hidden'))}, look-alike {d}/{len(kind('control'))}, "
              f"neutral spoke {n}/{len(kind('neutral'))}, items {sum(len(s) for s in task.values())}")


if __name__ == "__main__":
    main()
