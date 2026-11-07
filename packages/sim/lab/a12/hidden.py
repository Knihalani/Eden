# A12 (docs/research/a12-quality.md): hidden facts raised, Haiku-graded and Sonnet-corrected, per arm and paired.
#
# Each answer's verdict: the run's Haiku grader, replaced by Sonnet 5.5 where Sonnet regraded it (`regrade.ts`:
# --only-misses for every Haiku miss of eden, eden~reader and eden~nudge; --only-raised --sample N for a fixed sample
# of Haiku's "raised"; tools the other way round, every raised and a sample of misses). An answer Sonnet did not see
# counts at the expected value from its arm's sample (1 - the share of sampled "raised" Sonnet called missed; for tools'
# misses, the share Sonnet called raised). Concerns: control (and neutral) answers Haiku called a concern take Sonnet's
# --only-concerns verdict. Bootstrap 95% (5,000 draws, seed 1) over tasks; pairs are the same task (seed, template).
#
# usage: python3 -I hidden.py RUNS_DIR
import glob, json, os, random, sys

D = sys.argv[1]
runs = {}  # (task, arm) -> haiku verdict; kinds
kind = {}
cost = {}
# `a12-n2-*` ran after D317, when `eden` itself had the nudge (fixed after review): its arm is renamed "nudge-fixed".
def arm_of(name, condition):
    return "nudge-fixed" if "n2-" in name else condition


for f in sorted(glob.glob(os.path.join(D, "a12-[mnt]-4?.json")) + glob.glob(os.path.join(D, "a12-n*-4?.json"))):
    d = json.load(open(f))
    name = os.path.basename(f)
    for t in d["tasks"]:
        kind[t["id"]] = t["kind"]
    for r in d["results"]:
        if r.get("facts") is None:
            continue
        arm = arm_of(name, r["condition"])
        runs[(r["task"], arm)] = any(r["facts"].values())
        cost[(r["task"], arm)] = (r["costUsd"] + r["edenCostUsd"], r["wallMs"], r["toolCalls"])

sonnet = {}  # (task, arm) -> verdict
sampled = {}  # arm -> {"raised": [verdicts], "miss": [verdicts]} from the sample files only
conc = {}
for f in glob.glob(os.path.join(D, "rg-*.json")):
    name = os.path.basename(f)
    g = json.load(open(f))["graded"]
    for x in g:
        if x.get("facts") is None:
            continue
        v = any(x["facts"].values())
        arm = arm_of(name, x["condition"])
        key = (x["task"], arm)
        if name.startswith("rg-conc-"):
            conc[key] = v
            continue
        sonnet[key] = v
        if name.startswith(("rg-raised-m-", "rg-raised-n-", "rg-raised-n2-")):
            sampled.setdefault(arm, {}).setdefault("raised", []).append(v)
        if name.startswith("rg-miss-t-"):
            sampled.setdefault(arm, {}).setdefault("miss", []).append(v)


def expected(arm, haiku):
    s = sampled.get(arm, {})
    if haiku and s.get("raised"):
        return sum(s["raised"]) / len(s["raised"])
    if not haiku and s.get("miss"):
        return sum(s["miss"]) / len(s["miss"])
    return float(haiku)


def value(task, arm):
    h = runs[(task, arm)]
    return float(sonnet[(task, arm)]) if (task, arm) in sonnet else expected(arm, h)


def boot(xs):
    n = len(xs)
    mean = sum(xs) / n
    rng = random.Random(1)
    draws = sorted(sum(rng.choice(xs) for _ in xs) / n for _ in range(5000))
    return mean, draws[125], draws[4874]


arms = sorted({a for _, a in runs})
print("== hidden raised (n; Haiku; Sonnet-corrected, 95%)")
for arm in arms:
    ts = [t for (t, a) in runs if a == arm and kind[t] == "hidden"]
    if not ts:
        continue
    h = sum(runs[(t, arm)] for t in ts) / len(ts)
    m, lo, hi = boot([value(t, arm) for t in ts])
    s = sampled.get(arm, {})
    note = ""
    if s.get("raised"):
        note = f"  (raised sample: Sonnet agrees {sum(s['raised'])}/{len(s['raised'])})"
    if s.get("miss"):
        note = f"  (miss sample: Sonnet calls raised {sum(s['miss'])}/{len(s['miss'])})"
    print(f"{arm:12} n {len(ts):4}  Haiku {h:.3f}  Sonnet {m:.3f} ({lo:.3f}..{hi:.3f}){note}")

print("== paired (a - b), points, Sonnet-corrected; Haiku in brackets")
PAIRS = [("eden", "tools"), ("eden~reader", "eden"), ("eden~nudge", "eden"), ("eden~nudge", "eden~reader")]
PAIRS += [("nudge-fixed", "eden"), ("nudge-fixed", "eden~nudge")]
for a, b in PAIRS:
    ts = [t for (t, x) in runs if x == a and kind[t] == "hidden" and (t, b) in runs]
    if not ts:
        continue
    m, lo, hi = boot([value(t, a) - value(t, b) for t in ts])
    hm, hlo, hhi = boot([float(runs[(t, a)]) - float(runs[(t, b)]) for t in ts])
    print(
        f"{a:12} - {b:12} n {len(ts)}  {100 * m:+.1f} ({100 * lo:+.1f}..{100 * hi:+.1f})"
        f"  [Haiku {100 * hm:+.1f} ({100 * hlo:+.1f}..{100 * hhi:+.1f})]"
    )

print("== concerns (control, neutral): Haiku -> Sonnet-regraded")
for arm in arms:
    for k in ("control", "neutral"):
        ts = [t for (t, a) in runs if a == arm and kind[t] == k]
        if not ts:
            continue
        hk = sum(runs[(t, arm)] for t in ts)
        rg = sum(conc.get((t, arm), runs[(t, arm)]) for t in ts)
        print(f"{arm:12} {k:8} n {len(ts):4}  Haiku {hk}  regraded {rg}")

print("== per task: $/1k (agent + Eden), wall s, ask/tool calls; paired nudge arms - eden")
for k in ("hidden", "control", "neutral"):
    for arm in arms:
        ts = [t for (t, a) in runs if a == arm and kind[t] == k]
        if not ts:
            continue
        c = [cost[(t, arm)] for t in ts]
        print(
            f"{k:8} {arm:12} n {len(ts):4}  $/1k {1000 * sum(x[0] for x in c) / len(c):.3f}"
            f"  wall {sum(x[1] for x in c) / len(c) / 1000:.2f}  calls {sum(x[2] for x in c) / len(c):.2f}"
        )
    for arm in ("eden~nudge", "nudge-fixed"):
        ts = [t for (t, a) in runs if a == arm and kind[t] == k and (t, "eden") in runs]
        for i, label, scale in ((0, "$/1k", 1000), (1, "wall s", 0.001), (2, "calls", 1)):
            if not ts:
                break
            m, lo, hi = boot([scale * (cost[(t, arm)][i] - cost[(t, "eden")][i]) for t in ts])
            print(f"   {arm} - eden {k:8} {label:6} {m:+.3f} ({lo:+.3f}..{hi:+.3f}) n {len(ts)}")
