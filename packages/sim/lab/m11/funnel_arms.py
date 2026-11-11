"""M11: compare funnel JSONs (base first) by suite: hidden surfaced, decoys surfaced, pushHanded, neutral packets."""
import json, sys
from collections import Counter


def read(p):
    j = json.load(open(p))
    c = Counter()
    for r in j["perTask"]:
        k = "h" if r["variant"] == "hidden" else "d"
        for s in (r["suite"], "ALL", "HELD" if r["suite"][:6] in ("train5", "train6") or r["suite"] == "longtail" else "TRN"):
            c[(s, k)] += r.get("surfacedBy") is not None
            c[(s, k + "push")] += bool(r.get("pushHanded"))
            c[(s, k + "n")] += 1
    for s, v in j.get("neutral", {}).get("suites", {}).items():
        c[(s, "np")] += v["packets"]
        c[(s, "ni")] += v["items"]
        held = s[:6] in ("train5", "train6") or s == "longtail"
        c[("HELD" if held else "TRN", "np")] += v["packets"]
        c[("ALL", "np")] += v["packets"]
        c[("ALL", "ni")] += v["items"]
    return c


runs = [(p.split("/")[-1].replace(".json", ""), read(p)) for p in sys.argv[1:]]
suites = sorted({s for _, c in runs for (s, _) in c}, key=lambda s: (s in ("ALL", "HELD", "TRN"), s))
print(f"{'suite':9s} " + " | ".join(f"{n[:22]:>22s}" for n, _ in runs))
for s in suites:
    cells = []
    for _, c in runs:
        cells.append(f"h{c[(s,'h')]:4d} d{c[(s,'d')]:4d} np{c[(s,'np')]:5d}")
    print(f"{s:9s} " + " | ".join(f"{x:>22s}" for x in cells))
