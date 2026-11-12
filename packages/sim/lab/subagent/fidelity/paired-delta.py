"""F9 (D1104): the paired-delta check replay, validated against the API's own answers under changed check prompts.

    python3 -I paired-delta.py DIR [ARM …]

DIR holds one pilot-format directory per arm (`W` = the shipped prompt, then each arm, e.g. `A`, `R`), each with
`meta.json` (rows in the same order: `recorded` = the API's answer under that arm, `base` = the base run's recorded
API answer under the shipped prompt) and the subagents' answers as `b/*.C.json` ([{id, text}]). For each arm X it
compares three estimates of the API's answer under X with the real one:

- naive: the subagent's answer under X;
- no change: the API's recorded shipped-prompt answer (what an arm would read if the prompt change did nothing);
- paired delta: the API's recorded shipped-prompt answer, changed only where the subagent's answer changes between
  the shipped prompt and X (items it adds under X are added, items it drops are dropped).

It prints row-level agreement (speak/silent, same items, the planted fact or look-alike call) and the arm's effect on
three rates (planted named on hidden rows, look-alike named on control rows, any yes on neutral rows): the API's real
effect (X minus its shipped-prompt answer on the same rows) against each estimate's. The API's two answers under the
shipped prompt (`W`'s `recorded` and `base`) give the noise floor.
"""
import glob
import importlib.util
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cf", os.path.join(here, "check-fidelity.py"))
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)


def load(d):
    meta = json.load(open(os.path.join(d, "meta.json")))
    sub = {}
    for f in glob.glob(os.path.join(d, "b", "*.C.json")):
        for a in json.load(open(f)):
            i = int(a["id"])
            at = cf.parse(a.get("text", ""), len(meta[i]["items"]))
            sub[i] = None if at is None else frozenset(meta[i]["items"][j] for j in at)
    return meta, sub


def rates(rows, get):
    """(planted named on hidden, look-alike named on control, any yes on neutral) as counts and totals."""
    out = {}
    for s in ("kept", "control", "neutral"):
        ids = [i for i, m in rows if m["stratum"] == s and get(i) is not None]
        hit = sum((bool(get(i)) if s == "neutral" else m_planted(rows, i) in get(i)) for i in ids)
        out[s] = (hit, len(ids))
    return out


def m_planted(rows, i):
    return dict(rows)[i]["planted"]


def agree(rows, est, truth):
    ids = [i for i, _ in rows if est(i) is not None and truth(i) is not None]
    sp = sum(bool(est(i)) == bool(truth(i)) for i in ids) / max(1, len(ids))
    same = sum(est(i) == truth(i) for i in ids) / max(1, len(ids))
    key = [i for i in ids if m_planted(rows, i)]
    call = sum((m_planted(rows, i) in est(i)) == (m_planted(rows, i) in truth(i)) for i in key) / max(1, len(key))
    return f"speak/silent {sp:.3f}  same items {same:.3f}  planted/look-alike call {call:.3f}  (n {len(ids)})"


def fmt(r):
    return "  ".join(f"{s} {h}/{n}" for s, (h, n) in r.items())


def effect(rx, rw):
    return "  ".join(f"{s} {rx[s][0] - rw[s][0]:+d}" for s in rx)


def main():
    d = sys.argv[1]
    arms = sys.argv[2:] or ["A", "R"]
    wmeta, wsub = load(os.path.join(d, "W"))
    rows = list(enumerate(wmeta))
    base = {i: frozenset(m["base"] or []) for i, m in rows}
    api_w = {i: frozenset(m["recorded"] or []) for i, m in rows}
    print("noise floor, API vs API on the shipped prompt:", agree(rows, api_w.get, base.get))
    print("subagent vs API on the shipped prompt:", agree(rows, wsub.get, base.get))
    for arm in arms:
        xmeta, xsub = load(os.path.join(d, arm))
        api_x = {i: frozenset(m["recorded"] or []) for i, m in enumerate(xmeta)}

        def delta(i):
            if xsub.get(i) is None or wsub.get(i) is None:
                return None
            return (base[i] | (xsub[i] - wsub[i])) - (wsub[i] - xsub[i])

        print(f"\narm {arm}: estimates of the API's answer under {arm}, row by row")
        print("  naive (subagent under X):", agree(rows, xsub.get, api_x.get))
        print("  no change (API shipped): ", agree(rows, base.get, api_x.get))
        print("  paired delta:            ", agree(rows, delta, api_x.get))
        rb = rates(rows, base.get)
        print(f"  rates  API shipped {fmt(rb)}")
        print(f"         API {arm}       {fmt(rates(rows, api_x.get))}   effect {effect(rates(rows, api_x.get), rb)}")
        print(f"         sub {arm} - sub W              effect {effect(rates(rows, xsub.get), rates(rows, wsub.get))}")
        print(f"         paired delta   {fmt(rates(rows, delta))}   effect {effect(rates(rows, delta), rb)}")


if __name__ == "__main__":
    main()
