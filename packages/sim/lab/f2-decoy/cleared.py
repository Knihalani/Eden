"""F2-decoy: which rule took the planted fact (hidden) or the decoy (control) out of the push's pool, with its card's
kind, from a `pushDecoyFilter` run's pool dump (`cleared`). No model.

    python3 -I cleared.py POOL.jsonl... [--show RULE]
"""
import collections
import json
import sys


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show = sys.argv[sys.argv.index("--show") + 1] if "--show" in sys.argv else None
    if show in args:
        args.remove(show)
    c = collections.Counter()
    for f in args:
        seen = set()
        for line in open(f):
            p = json.loads(line)
            key = (p["suite"], p["seed"], p["variant"], p["template"])
            for x in p.get("cleared", []):
                if x["id"] != p["planted"] or key in seen or p["variant"] not in ("hidden", "control"):
                    continue
                seen.add(key)
                kind = (x.get("card") or {}).get("kind")
                c[(p["variant"], x["why"], kind)] += 1
                if show == x["why"] and p["variant"] == "hidden":
                    card = x.get("card") or {}
                    print(f"- {p['template']}: {p['request'][:110]}")
                    print(f"    card {kind} {card.get('actions')} {card.get('start')}..{card.get('end')}"
                          f" {card.get('entities')} : {card.get('statement', '')[:110]}")
    for k, n in sorted(c.items(), key=lambda kv: (kv[0][1], kv[0][0], str(kv[0][2]))):
        print(f"  {k[1]:6} {k[0]:8} card {str(k[2]):14} {n}")


if __name__ == "__main__":
    main()
