"""M11: compare funnel JSONs (base first) by suite: hidden surfaced, decoys surfaced, pushHanded, neutral packets."""
import json, sys
from collections import Counter


def read(p):
    j = json.load(open(p))
    c = Counter()
    for r in j["perTask"]:
        k = "h" if r["variant"] == "hidden" else "d"
        grp = "HELD" if r["suite"][:6] in ("train5", "train6") or r["suite"] == "longtail" else (
            "VAL" if r["suite"][:6] in ("train3", "train4") else "TRN")
        # ALL leaves the held-out families out (the bar reads HELD, once): selection never sees them.
        for s in (r["suite"], grp) + (("ALL",) if grp != "HELD" else ()):
            c[(s, k)] += r.get("surfacedBy") is not None
            c[(s, k + "push")] += bool(r.get("pushHanded"))
            c[(s, k + "n")] += 1
    for s, v in j.get("neutral", {}).get("suites", {}).items():
        c[(s, "np")] += v["packets"]
        c[(s, "ni")] += v["items"]
        grp = "HELD" if s[:6] in ("train5", "train6") or s == "longtail" else ("VAL" if s[:6] in ("train3", "train4") else "TRN")
        c[(grp, "np")] += v["packets"]
        if grp != "HELD":
            c[("ALL", "np")] += v["packets"]
            c[("ALL", "ni")] += v["items"]
    return c


runs = [(p.split("/")[-1].replace(".json", ""), read(p)) for p in sys.argv[1:] if p != "--held"]
# HELD_SUITES (the bar) are printed only with --held: selection reads VAL (train3-4, 3r-4r) and TRN.
show_held = "--held" in sys.argv
suites = sorted({s for _, c in runs for (s, _) in c if show_held or not (s == "HELD" or s[:6] in ("train5", "train6") or s == "longtail")},
                key=lambda s: (s in ("ALL", "HELD", "VAL", "TRN"), s))
print(f"{'suite':9s} " + " | ".join(f"{n[:22]:>22s}" for n, _ in runs))
for s in suites:
    cells = []
    for _, c in runs:
        cells.append(f"h{c[(s,'h')]:4d} d{c[(s,'d')]:4d} np{c[(s,'np')]:5d}")
    print(f"{s:9s} " + " | ".join(f"{x:>22s}" for x in cells))
