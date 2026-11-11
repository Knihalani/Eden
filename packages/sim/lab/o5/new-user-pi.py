#!/usr/bin/env python3
"""O5 (docs/research/o4-new-user.md 6a): the paid check of syncKick on new users, from pi-ab --connect-at results.
   python3 -I packages/sim/lab/o5/new-user-pi.py [--base eden] [--arm eden~K] [--sonnet regrade.json ...] RUN.json ...
Raised: a hidden answer with any fact true. Concern: a control or neutral answer with any fact true (with --sonnet,
only where that regrade's grader agrees). Pairs are (seed, task, checkpoint) across the two arms; a task id names its
seed (w41:train1:name). Intervals: 95%, a bootstrap that resamples tasks, a task's seeds and checkpoints together
(the cluster is the id without its seed), 4,000 draws, seed 1."""
import collections, json, random, sys

args = sys.argv[1:]
def take(flag, default):
    if flag in args:
        i = args.index(flag); v = args[i + 1]; del args[i:i + 2]; return v
    return default
BASE, ARM = take("--base", "eden"), take("--arm", "eden~K")
sonnet = []
while "--sonnet" in args:
    sonnet.append(take("--sonnet", ""))
kind, rows, users = {}, [], []
for path in args:
    d = json.load(open(path))
    for t in d["tasks"]:
        kind[t["id"]] = (t["kind"], len(t["must"]))
    rows += d["results"]
    users += d["connect"]["users"]
# The Sonnet regrade's verdicts, by (task, condition, checkpoint).
confirmed = None
if sonnet:
    confirmed = {}
    for path in sonnet:
        g = json.load(open(path))
        for x in g["graded"]:
            confirmed[(x["task"], x["condition"], x.get("connectS"))] = any((x.get("facts") or {}).values())
hit = lambda r: bool(r.get("facts")) and any(r["facts"].values())
def concern(r):
    if not hit(r):
        return False
    return True if confirmed is None else confirmed.get((r["task"], r["condition"], r["connectS"]), False)
by = {(r["task"], r["condition"], r["connectS"]): r for r in rows}
errors = collections.Counter(r["condition"] for r in rows if r.get("error"))
print(f"{len(rows)} task runs; errors {dict(errors) or 0}; ungraded "
      f"{sum(1 for r in rows if not r.get('error') and r.get('facts') is None and kind[r['task']][1])}")
rng = random.Random(1)
cluster = lambda t: t.split(":", 1)[1]  # the task without its seed: its seeds are resampled together
def boot(groups):
    """95% interval of the mean difference, resampling whole groups (lists of differences)."""
    def draw():
        pick = [groups[rng.randrange(len(groups))] for _ in groups]
        return sum(sum(d) for d in pick) / max(1, sum(len(d) for d in pick))
    boots = sorted(draw() for _ in range(4000))
    return boots[100], boots[3899]
def paired(kinds, at, f):
    tasks = sorted({t for (t, c, s) in by if kind[t][0] in kinds and s == at
                    and (t, BASE, s) in by and (t, ARM, s) in by
                    and not by[(t, BASE, s)].get("error") and not by[(t, ARM, s)].get("error")})
    a = [f(by[(t, BASE, at)]) for t in tasks]; b = [f(by[(t, ARM, at)]) for t in tasks]
    n = len(tasks)
    if n == 0:
        return "no pairs"
    diffs = [y - x for x, y in zip(a, b)]
    groups = collections.defaultdict(list)
    for t, d in zip(tasks, diffs):
        groups[cluster(t)].append(d)
    lo, hi = boot(list(groups.values()))
    return (f"n {n:4d} | {BASE} {sum(a):4d} {100 * sum(a) / n:5.1f}% | {ARM} {sum(b):4d} {100 * sum(b) / n:5.1f}% | "
            f"diff {100 * sum(diffs) / n:+5.1f} points ({100 * lo:+.1f}..{100 * hi:+.1f})")
ats = sorted({r["connectS"] for r in rows})
for at in ats:
    print(f"hidden raised at {at:g} s:            {paired({'hidden'}, at, hit)}")
for at in ats:
    label = "confirmed concerns" if confirmed is not None else "concerns (run's grader)"
    print(f"{label} at {at:g} s, control: {paired({'control'}, at, concern)}")
    print(f"{label} at {at:g} s, neutral: {paired({'neutral'}, at, concern)}")
# Pooled over both checkpoints, tasks resampled whole.
def pooled(kinds, f):
    tasks = sorted({t for (t, c, s) in by if kind[t][0] in kinds})
    groups = collections.defaultdict(list)
    for t in tasks:
        groups[cluster(t)] += [f(by[(t, ARM, s)]) - f(by[(t, BASE, s)]) for s in ats
                               if (t, BASE, s) in by and (t, ARM, s) in by
                               and not by[(t, BASE, s)].get("error") and not by[(t, ARM, s)].get("error")]
    per = [d for d in groups.values() if d]
    n = sum(len(d) for d in per)
    if not n:
        return "no pairs"
    lo, hi = boot(per)
    return f"n {n} | diff {100 * sum(sum(d) for d in per) / n:+.2f} points ({100 * lo:+.2f}..{100 * hi:+.2f})"
print(f"concerns, control and neutral, both checkpoints: {pooled({'control', 'neutral'}, concern)}")
for c in (BASE, ARM):
    u = [x for x in users if x["condition"] == c]
    warm = sorted(x["warmS"] for x in u if x["warmS"] is not None)
    calls = sum(x["sourceCalls"] for x in u) / max(1, len(u))
    med = warm[len(warm) // 2] if warm else float("nan")
    print(f"{c:8s}: {len(u)} users, connector calls a user {calls:.2f}, backfill complete in {len(warm)} of {len(u)}"
          f" (median {med:.1f} s)")
cb = sum(x["sourceCalls"] for x in users if x["condition"] == BASE) / max(1, sum(1 for x in users if x["condition"] == BASE))
ca = sum(x["sourceCalls"] for x in users if x["condition"] == ARM) / max(1, sum(1 for x in users if x["condition"] == ARM))
print(f"connector calls a user: {100 * (ca / cb - 1):+.1f}%")
for c in (BASE, ARM):
    for at in ats:
        v = [r for r in rows if r["condition"] == c and r["connectS"] == at and not r.get("error")]
        print(f"{c:8s} at {at:g} s: backfill complete at the request {sum(1 for r in v if r['warmAtRequest'])} of {len(v)}, "
              f"items held {sum(r['syncedAtRequest'] for r in v) / max(1, len(v)):.0f}, "
              f"task wall {sum(r['wallMs'] for r in v) / max(1, len(v)) / 1000:.2f} s, "
              f"${1000 * sum(r['costUsd'] + r['edenCostUsd'] for r in v) / max(1, len(v)):.3f}/1k")
