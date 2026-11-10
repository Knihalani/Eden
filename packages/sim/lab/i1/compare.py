"""I1's funnel screen, task by task (D473, docs/research/i1-checker.md §1's bar). Lab only.

    python3 -I compare.py --base BASE.json --trial TRIAL.json [--eval-share 0.2]

Both are `bun run funnel --json` runs on train with `-- --neutral`. Per split (the held-out templates, `eval`, by the
same hash as `i1-label.ts splitOf`; the train templates; all) and for seeds 41-42 alone: hidden and decoys surfaced
(a row's `surfacedBy`), tasks gained and lost, candidates packets on neutral tasks (`pushHandedN` > 0) and the
packets' bytes by variant. Then the pre-registered bar on the held-out templates over every seed in the runs.
"""
import argparse
import hashlib
import json
import sys


def split_of(suite, template, share):
    h = hashlib.sha256(f"{suite}/{template}".encode()).hexdigest()
    return "eval" if int(h[:8], 16) / 0xFFFFFFFF < share else "train"


def key(r, variant=None):
    return (r["suite"], r["seed"], variant or r.get("variant", "neutral"), r["template"])


def load(path):
    j = json.load(open(path))
    rows = {key(r): r for r in j["perTask"]}
    rows.update({key(r, "neutral"): r for r in j.get("neutral", {}).get("perTask", [])})
    return rows


def tally(base, trial, keep):
    out = {}
    for v in ("hidden", "control", "neutral"):
        ks = [k for k in base if k[2] == v and keep(k)]
        b = {k for k in ks if base[k].get("surfacedBy")}
        t = {k for k in ks if k in trial and trial[k].get("surfacedBy")}
        out[v] = {
            "n": len(ks), "base": len(b), "trial": len(t), "gained": len(t - b), "lost": len(b - t),
            "candidates_base": sum(1 for k in ks if base[k].get("pushHandedN", 0) > 0),
            "candidates_trial": sum(1 for k in ks if trial.get(k, {}).get("pushHandedN", 0) > 0),
            "bytes_base": sum(base[k].get("packetBytes", 0) for k in ks),
            "bytes_trial": sum(trial.get(k, {}).get("packetBytes", 0) for k in ks),
            "handed_planted_base": sum(1 for k in ks if base[k].get("pushHanded")),
            "handed_planted_trial": sum(1 for k in ks if trial.get(k, {}).get("pushHanded")),
        }
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--trial", required=True)
    ap.add_argument("--eval-share", type=float, default=0.2)
    ap.add_argument("--bar", choices=["i1", "i2"], default="i1", help="i2: D493's packet bar (docs/research/i2-…)")
    a = ap.parse_args(argv)
    base, trial = load(a.base), load(a.trial)
    sp = lambda k: split_of(k[0], k[3], a.eval_share)  # noqa: E731
    views = {
        "held-out templates (primary)": lambda k: sp(k) == "eval",
        "train templates (in-sample)": lambda k: sp(k) == "train",
        "all": lambda k: True,
        "all, seeds 41-42 (vs 314/273)": lambda k: k[1] in (41, 42),
    }
    res = {name: tally(base, trial, f) for name, f in views.items()}
    for name, t in res.items():
        h, c, n = t["hidden"], t["control"], t["neutral"]
        print(f"{name}: hidden {h['base']} -> {h['trial']} of {h['n']} (+{h['gained']} -{h['lost']}); "
              f"decoys {c['base']} -> {c['trial']} of {c['n']} (+{c['gained']} -{c['lost']}); "
              f"planted handed {h['handed_planted_base']} -> {h['handed_planted_trial']}, "
              f"decoy handed {c['handed_planted_base']} -> {c['handed_planted_trial']}; "
              f"candidates packets hidden/control/neutral {h['candidates_base']}/{c['candidates_base']}/"
              f"{n['candidates_base']} -> {h['candidates_trial']}/{c['candidates_trial']}/{n['candidates_trial']}; "
              f"packet KB hidden/control/neutral {h['bytes_base'] // 1000}/{c['bytes_base'] // 1000}/"
              f"{n['bytes_base'] // 1000} -> {h['bytes_trial'] // 1000}/{c['bytes_trial'] // 1000}/"
              f"{n['bytes_trial'] // 1000}")
    p = res["held-out templates (primary)"]
    dh = p["hidden"]["trial"] - p["hidden"]["base"]
    dd = p["control"]["trial"] - p["control"]["base"]
    neutral_ok = p["neutral"]["candidates_trial"] <= p["neutral"]["candidates_base"]
    one = dh >= 4 and dd <= 2
    two = dd <= -8 and dh >= -2
    verdict = "PASS" if (one or two) and neutral_ok else "FAIL"
    if a.bar == "i2":
        # D493: the packet, not "surfaced" (the ask path hides a packet's loss in the funnel; D257 showed it costs live).
        ph = p["hidden"]["handed_planted_trial"] - p["hidden"]["handed_planted_base"]
        dc = p["control"]["handed_planted_trial"] - p["control"]["handed_planted_base"]
        ok = {"decoy handed -16 or fewer": dc <= -16, "planted handed -5 or better": ph >= -5,
              "hidden surfaced -2 or better": dh >= -2, "decoys surfaced +2 or fewer": dd <= 2, "neutral packets": neutral_ok}
        verdict = "PASS" if all(ok.values()) else "FAIL"
        print(f"I2 BAR (held-out templates): planted handed {ph:+d}, decoy handed {dc:+d}, hidden {dh:+d}, "
              f"decoys {dd:+d}; " + ", ".join(f"{k} {'yes' if v else 'no'}" for k, v in ok.items()) + f" -> {verdict}")
        print(json.dumps(res))
        return
    print(f"BAR (held-out templates): hidden {dh:+d}, decoys {dd:+d}, neutral candidates "
          f"{p['neutral']['candidates_base']} -> {p['neutral']['candidates_trial']}: "
          f"clause 1 {'yes' if one else 'no'}, clause 2 {'yes' if two else 'no'}, neutral {'ok' if neutral_ok else 'up'}"
          f" -> {verdict}")
    print(json.dumps(res))


if __name__ == "__main__":
    main(sys.argv[1:])
