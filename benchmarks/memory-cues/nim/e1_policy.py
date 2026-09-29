"""E1: R1 Addendum A action-class trigger (policy_trigger.py, lexicon unchanged) on the new kimi-k3 policy-need cues.
Reports policy recall (all 24 classes / high-stakes only), any-inject on negatives, and other positives gaining a policy bullet."""
import json, collections
import policy_trigger as PT

cues = json.load(open(__import__("os").environ.get("CUES", "fixture/cues-all.json")))


def run(sel, high):
    o = collections.Counter()
    for c in cues:
        if not sel(c):
            continue
        cls = PT.fired(c["cue"] + " \n" + c.get("prev_turn", ""))
        if high:
            cls &= PT.HIGH
        inj = {p for p, cs in PT.POLICY.items() if cls & set(cs)}
        gp = {g for g in c["gold"] if g.startswith("p")}
        o["n"] += 1; o["any"] += bool(inj); o["bullets"] += len(inj)
        if gp:
            o["gold"] += len(gp); o["hit"] += len(gp & inj); o["wrong"] += len(inj - gp)
            o["reach"] += sum(1 for g in gp if (set(PT.POLICY[g]) & PT.HIGH) or not high)
        elif c["gold"]:
            o["other_gain"] += bool(inj)
    return o


SETS = {
    "R1 test policy (hand)": lambda c: c["split"] == "test" and c["cat"] == "policy",
    "test_nim policy-need (kimi)": lambda c: c["cat"] == "nim-policy",
    "test_nim para cues of policy rows": lambda c: c["cat"] == "nim-para" and c["gold"][0].startswith("p"),
    "R1 test negatives": lambda c: c["split"] == "test" and not c["gold"],
    "test_nim negatives (kimi)": lambda c: c["cat"] == "nim-neg",
    "R1 test other positives": lambda c: c["split"] == "test" and c["gold"] and c["cat"] != "policy",
    "test_nim para, non-policy rows": lambda c: c["cat"] == "nim-para" and not c["gold"][0].startswith("p"),
}
if __name__ == "__main__":
    res = {}
    for high in (False, True):
        for name, sel in SETS.items():
            o = run(sel, high)
            r = dict(n=o["n"], any_inject=o["any"] / o["n"], bullets_per_cue=o["bullets"] / o["n"])
            if o["gold"]:
                r.update(recall=o["hit"] / o["gold"], recall_reachable=o["hit"] / max(1, o["reach"]), reachable=o["reach"], gold=o["gold"], wrong_per_cue=o["wrong"] / o["n"])
            if "other" in name or "non-policy" in name:
                r["gain_policy_bullet"] = o["other_gain"] / o["n"]
            res[f"{'high' if high else 'all24'}|{name}"] = r
            print(("HIGH " if high else "ALL24 ") + name, {k: round(v, 3) if isinstance(v, float) else v for k, v in r.items()})
    json.dump(res, open("out/e1-policy-trigger.json", "w"), indent=1)
