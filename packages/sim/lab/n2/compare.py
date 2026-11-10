"""N2's funnel comparisons (D510-D513, docs/research/n2-recall.md §1), lab only.

    python3 -I compare.py --arm C0=base.json --arm C1=c1.json ... [--split all|eval|train] [--seeds 41,42]

Each file is a `bun run funnel --json` run on train with `-- --neutral`. Per arm: hidden and decoys surfaced (a row's
`surfacedBy`), planted (decoy) handed (`pushHanded`: in the candidates packet), neutral tasks given a candidates packet
(`pushHandedN` > 0) and packet KB by variant; then each pre-registered bar, task by task, on the tasks both arms ran.
`--split eval` keeps I2's held-out templates (the hash of `i1-label.ts splitOf`, share 0.2).
"""
import argparse
import hashlib
import json
import sys


def split_of(suite, template, share=0.2):
    h = hashlib.sha256(f"{suite}/{template}".encode()).hexdigest()
    return "eval" if int(h[:8], 16) / 0xFFFFFFFF < share else "train"


def load(path):
    j = json.load(open(path))
    rows = {(r["suite"], r["seed"], r.get("variant", "neutral"), r["template"]): r for r in j["perTask"]}
    rows.update({(r["suite"], r["seed"], "neutral", r["template"]): r for r in j.get("neutral", {}).get("perTask", [])})
    return rows


def figures(rows, keys):
    out = {}
    for v in ("hidden", "control", "neutral"):
        ks = [k for k in keys if k[2] == v]
        out[v] = {
            "n": len(ks),
            "surfaced": sum(1 for k in ks if rows[k].get("surfacedBy")),
            "handed": sum(1 for k in ks if rows[k].get("pushHanded")),
            "packets": sum(1 for k in ks if rows[k].get("pushHandedN", 0) > 0),
            "kb": sum(rows[k].get("packetBytes", 0) for k in ks) // 1000,
        }
    return out


def line(name, f):
    h, c, n = f["hidden"], f["control"], f["neutral"]
    return (f"{name:4} hidden {h['surfaced']}/{h['n']} decoys {c['surfaced']}/{c['n']} | planted handed {h['handed']} "
            f"decoy handed {c['handed']} | neutral packets {n['packets']}/{n['n']} | KB {h['kb']}/{c['kb']}/{n['kb']}")


def diff(a, b, keys, variant, field):
    """Tasks gained and lost by b against a."""
    ks = [k for k in keys if k[2] == variant]
    get = (lambda r: bool(r.get("surfacedBy"))) if field == "surfaced" else (lambda r: bool(r.get("pushHanded")))
    gained = sum(1 for k in ks if get(b[k]) and not get(a[k]))
    lost = sum(1 for k in ks if get(a[k]) and not get(b[k]))
    return gained, lost


def bars(arms, keys, confirm):
    F = {n: figures(r, keys) for n, r in arms.items()}
    out = []

    def check(label, ok):
        out.append(f"  [{'pass' if ok else 'FAIL'}] {label}")
        return ok

    if {"C1", "C3"} <= F.keys():
        a, b = F["C1"], F["C3"]
        d = b["hidden"]["handed"] - a["hidden"]["handed"]
        e = b["control"]["handed"] - a["control"]["handed"]
        out.append("H1 (C3 against C1):")
        ok = check(f"planted handed {d:+d} >= {2 if confirm else 8:+d}", d >= (2 if confirm else 8))
        ok &= check(f"decoy handed {e:+d} <= {1 if confirm else 3:+d}", e <= (1 if confirm else 3))
        ok &= check(f"hidden surfaced {b['hidden']['surfaced'] - a['hidden']['surfaced']:+d} >= 0",
                    b["hidden"]["surfaced"] >= a["hidden"]["surfaced"])
        np_, na = b["neutral"]["packets"], a["neutral"]["packets"]
        ok &= check(f"neutral packets {na} -> {np_} <= +5%", np_ <= na * 1.05)
        if "C0" in F:
            ok &= check(f"decoy handed {b['control']['handed']} <= C0's {F['C0']['control']['handed']}",
                        b["control"]["handed"] <= F["C0"]["control"]["handed"])
        out.append(f"  H1: {'PASS' if ok else 'FAIL'}")
    if {"C1", "C2"} <= F.keys():
        a, b = F["C1"], F["C2"]
        out.append("H3 (C2 against C1):")
        ok = check(f"planted handed {b['hidden']['handed'] - a['hidden']['handed']:+d} >= -2",
                   b["hidden"]["handed"] - a["hidden"]["handed"] >= -2)
        ok &= check(f"hidden surfaced {b['hidden']['surfaced'] - a['hidden']['surfaced']:+d} >= -2",
                    b["hidden"]["surfaced"] - a["hidden"]["surfaced"] >= -2)
        ok &= check(f"neutral packets {a['neutral']['packets']} -> {b['neutral']['packets']} at least halved",
                    b["neutral"]["packets"] * 2 <= a["neutral"]["packets"])
        out.append(f"  H3: {'PASS' if ok else 'FAIL'}")
    if {"C0", "C4"} <= F.keys():
        a, b = F["C0"], F["C4"]
        out.append("H1+H3 (C4 against C0):")
        ok = check(f"planted handed {a['hidden']['handed']} -> {b['hidden']['handed']} >= C0's",
                   b["hidden"]["handed"] >= a["hidden"]["handed"])
        ok &= check(f"decoy handed {a['control']['handed']} -> {b['control']['handed']} <= 90% of C0's",
                    b["control"]["handed"] <= 0.9 * a["control"]["handed"])
        ok &= check(f"hidden surfaced {a['hidden']['surfaced']} -> {b['hidden']['surfaced']} >= C0's",
                    b["hidden"]["surfaced"] >= a["hidden"]["surfaced"])
        ok &= check(f"neutral packets {a['neutral']['packets']} -> {b['neutral']['packets']} at least halved",
                    b["neutral"]["packets"] * 2 <= a["neutral"]["packets"])
        out.append(f"  H1+H3: {'PASS' if ok else 'FAIL'}")
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", action="append", required=True, help="NAME=funnel.json")
    ap.add_argument("--split", choices=["all", "eval", "train"], default="all")
    ap.add_argument("--seeds", default="")
    ap.add_argument("--confirm", action="store_true", help="the confirmation's bars (fresh worlds, held-out templates)")
    a = ap.parse_args(argv)
    arms = {}
    for spec in a.arm:
        name, path = spec.split("=", 1)
        arms[name] = load(path)
    seeds = {int(s) for s in a.seeds.split(",") if s}
    keys = set.intersection(*(set(r) for r in arms.values()))
    keys = sorted(k for k in keys if (a.split == "all" or split_of(k[0], k[3]) == a.split)
                  and (not seeds or k[1] in seeds))
    first = next(iter(arms))
    print(f"{len(keys)} tasks in every arm (split {a.split}{', seeds ' + a.seeds if seeds else ''})")
    for n, r in arms.items():
        print(line(n, figures(r, keys)))
        if n != first:
            for v, f in (("hidden", "surfaced"), ("hidden", "handed"), ("control", "surfaced"), ("control", "handed")):
                g, lo = diff(arms[first], r, keys, v, f)
                print(f"       vs {first}: {v} {f} +{g} -{lo}")
    print("\n".join(bars(arms, keys, a.confirm)))


if __name__ == "__main__":
    main(sys.argv[1:])
