"""C5-E7 head-to-head report: per-group mean (condition − none) and the per-turn utility with dev's real group shares."""
import glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARES = {"code": {"plan": 0.141, "labeler-only": 0.171, "no-need": 0.688},
          "life": {"plan": 0.137, "labeler-only": 0.215, "no-need": 0.648}}


def report(world, sub):
    d = os.path.join(HERE, "downstream", sub)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = {}
    for p in glob.glob(os.path.join(d, "out", "judged-*.json")):
        judged.update({c["event"]: c["scores"] for c in json.load(open(p))["cases"]})
    by = {}
    for eid, k in key.items():
        if eid not in judged:
            continue
        s = dict(zip(k["order"], judged[eid]))
        g = by.setdefault(k["group"], {"n": 0})
        g["n"] += 1
        for c in s:
            if c != "none":
                g[c] = g.get(c, 0) + s[c] - s["none"]
                g[c + "+"] = g.get(c + "+", 0) + (s[c] > s["none"])
                g[c + "-"] = g.get(c + "-", 0) + (s[c] < s["none"])
    out = {}
    for c in ("eden", "verify"):
        out[c] = round(sum(SHARES[world][g] * by[g][c] / by[g]["n"] for g in by), 4)
    for g, v in by.items():
        print(world, g, {"n": v["n"], **{c: round(v[c] / v["n"], 3) for c in ("eden", "verify")},
                         "better/worse eden": (v["eden+"], v["eden-"]), "better/worse verify": (v["verify+"], v["verify-"])})
    print(world, "utility per turn:", out, "verify − eden:", round(out["verify"] - out["eden"], 4))


if __name__ == "__main__":
    for w in sys.argv[1:]:
        report(w, f"{w}-h2h")
