"""M1 (D895, docs/research/m1-student.md §2b): the funnel screen of `pushCheckLocal`, task by task, on M1's splits:
the dev templates (where the pass mark is chosen), the 40 held-out templates (the bar, read once) and the in-sample
templates. Reuses I1's `compare.tally`; the splits are m1_data's. Lab only.

    python3 -I packages/sim/lab/m1/compare.py --base BASE.json --trial TRIAL.json [--bar]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "i1"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "modal"))
import compare as c  # noqa: E402
import m1_data as d  # noqa: E402


def split(k):
    """A task's M1 split: I1/I2's held-out templates are `eval`; 15% of the rest by m1_data's hash are `dev`."""
    if c.split_of(k[0], k[3], 0.2) == "eval":
        return "eval"
    return "dev" if d.family_split(f"{k[0]}/{k[3]}", 0.15, "m1-dev") == "eval" else "train"


def line(name, t):
    h, ct, n = t["hidden"], t["control"], t["neutral"]
    return (f"{name}: hidden {h['base']} -> {h['trial']} of {h['n']} (+{h['gained']} -{h['lost']}); "
            f"decoys {ct['base']} -> {ct['trial']} (+{ct['gained']} -{ct['lost']}); "
            f"planted handed {h['handed_planted_base']} -> {h['handed_planted_trial']}, "
            f"decoy handed {ct['handed_planted_base']} -> {ct['handed_planted_trial']}; "
            f"neutral packets {n['candidates_base']} -> {n['candidates_trial']} of {n['n']}; "
            f"packet KB h/c/n {h['bytes_base'] // 1000}/{ct['bytes_base'] // 1000}/{n['bytes_base'] // 1000} -> "
            f"{h['bytes_trial'] // 1000}/{ct['bytes_trial'] // 1000}/{n['bytes_trial'] // 1000}")


def bar(t):
    """D895: D493's clauses doubled for eight seeds."""
    h, ct, n = t["hidden"], t["control"], t["neutral"]
    ok = {
        "decoy handed -32 or fewer": ct["handed_planted_trial"] - ct["handed_planted_base"] <= -32,
        "planted handed -10 or better": h["handed_planted_trial"] - h["handed_planted_base"] >= -10,
        "hidden surfaced -4 or better": h["trial"] - h["base"] >= -4,
        "decoys surfaced +4 or fewer": ct["trial"] - ct["base"] <= 4,
        "neutral packets not up": n["candidates_trial"] <= n["candidates_base"],
    }
    return ok, all(ok.values())


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--trial", required=True)
    ap.add_argument("--bar", action="store_true", help="also read the held-out templates and the bar (once)")
    a = ap.parse_args(argv)
    base, trial = c.load(a.base), c.load(a.trial)
    views = {"dev templates": "dev", "in-sample templates": "train"}
    if a.bar:
        views["held-out templates (the bar)"] = "eval"
    out = {}
    for name, sp in views.items():
        t = c.tally(base, trial, lambda k, sp=sp: split(k) == sp)
        out[name] = t
        print(line(name, t))
        if sp == "dev":
            h, ct = t["hidden"], t["control"]
            print(f"  dev score (planted handed - decoys handed): "
                  f"{h['handed_planted_trial'] - ct['handed_planted_trial']} (default "
                  f"{h['handed_planted_base'] - ct['handed_planted_base']})")
    if a.bar:
        ok, passed = bar(out["held-out templates (the bar)"])
        print("M1 BAR (D895, held-out templates): " + ", ".join(f"{k} {'yes' if v else 'no'}" for k, v in ok.items())
              + f" -> {'PASS' if passed else 'FAIL'}")
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
