"""Action-class trigger for policy memories (R1 open question).

Lexicon written from the 30 policy memory texts + a generic action taxonomy,
BEFORE scoring. Caveat: the author had seen 12 of the 60 policy cues.
Evaluates once on all splits; reports dev and test separately.

A policy memory is compiled to one or more action classes. A cue fires a class
when any class pattern matches the cue (prompt + prev_turn). A policy memory
is injected iff one of its classes fires.
"""
import json, re, sys, collections

CLASSES = {
  # integrate work into the mainline / finish a PR
  "integrate": r"\b(merge[ds]?|merging|land(ed|ing)?|ship(ped|ping)?|get it (in|merged)|close (it|this) out|finish(ed)? up|wrap(ped)? up)\b",
  # open / request review
  "review":    r"\b(pull request|PR|review|put (it|this) up)\b",
  # declare completion / readiness
  "complete":  r"\b(done|finished|complete[d]?|good to go|ready|lgtm|all set)\b",
  # commit / push / sync remote
  "commit":    r"\b(commit(ted|ting)?|push(ed|ing)?|sync|upload)\b",
  "branch":    r"\b(branch(es)?|main|master|checkout)\b",
  "rewrite_history": r"\b(squash|rebase|amend|force[- ]push|rewrite (the )?history)\b",
  "stash":     r"\bstash\b",
  "deploy":    r"\b(deploy(ed|ing|ment)?|release|prod(uction)?|publish(ed|ing)?|roll ?out)\b",
  "delete":    r"\b(delete|remove|rm\b|clean ?up|prune|drop)\w*",
  "dependency":r"\b(add(ing)? (a |the )?(dep|dependency|package|library|lib)|install\w*|npm i\b|pnpm add|yarn add|bump|upgrade)\b",
  "db_destructive": r"\b(drop|truncate|reset|wipe)\b.*\b(db|database|table|schema)\b|\b(db|database)\b.*\b(reset|wipe|drop)\b",
  "tests":     r"\b(test(s|ing)?|spec|ci|flak\w*|skip\w*|disable\w*)\b",
  "generated": r"\b(dist/|\.gen\.ts|generated)\b",
  "refactor":  r"\b(refactor\w*|rewrite|restructure|re-architect\w*|big change)\b",
  "explain":   r"\b(explain|what (is|does)|why (is|does)|summari[sz]e|walk me through)\b",
  "research":  r"\b(research|investigate|look into|dig into|compare)\b",
  "billing":   r"\b(billing|invoice|payment|stripe|charge)\w*",
  "github":    r"\b(github|gh\b|issue|actions)\b",
  "scripts":   r"\b(script|\.js\b|javascript)\b",
  "docs":      r"\b(docs?|documentation|readme|public (api|behaviou?r))\b",
  "benchmark": r"\b(bench(mark)?s?|perf(ormance)? run)\b",
  "secrets":   r"\b(log(s|ging)?|token|secret|password|error message)\b",
  "commit_msg":r"\b(commit message|message)\b",
  "emoji":     r"\bemoji",
}

# policy memory -> action classes (compiled from the memory text only)
POLICY = {
  "p01": ["integrate"], "p02": ["review", "complete"], "p03": ["commit", "branch"],
  "p04": ["commit"], "p05": ["complete"], "p06": ["review", "complete"],
  "p07": ["explain"], "p08": ["research"], "p09": ["delete"], "p10": ["deploy"],
  "p11": ["review"], "p12": ["dependency"], "p13": ["generated"], "p14": ["db_destructive"],
  "p15": ["commit"], "p16": ["rewrite_history"], "p17": ["complete"], "p18": ["refactor"],
  "p19": ["stash"], "p20": ["tests"], "p21": ["github", "review"], "p22": ["billing"],
  "p23": ["emoji", "commit_msg"], "p24": ["commit_msg", "commit"], "p25": ["dependency"],
  "p26": ["scripts"], "p27": ["secrets"], "p28": ["complete"], "p29": ["docs"], "p30": ["benchmark"],
}

RX = {k: re.compile(v, re.I) for k, v in CLASSES.items()}

def fired(text):
    return {k for k, rx in RX.items() if rx.search(text)}

def run(max_per_class=None, use_prev=True):
    cues = json.load(open("fixture/cues.json"))
    out = collections.defaultdict(lambda: collections.Counter())
    for c in cues:
        text = c["cue"] + (" \n" + c.get("prev_turn", "") if use_prev else "")
        cls = fired(text)
        inj = {p for p, cs in POLICY.items() if cls & set(cs)}
        gold_pol = {g for g in c["gold"] if g.startswith("p")}
        key = (c["split"], "policy" if c["cat"] == "policy" else ("neg" if not c["gold"] else "other"))
        o = out[key]
        o["n"] += 1
        o["injected_bullets"] += len(inj)
        o["any_inject"] += bool(inj)
        if gold_pol:
            o["gold"] += len(gold_pol)
            o["gold_hit"] += len(gold_pol & inj)
            o["cue_hit"] += bool(gold_pol & inj)
            o["wrong_policy_bullets"] += len(inj - gold_pol)
    return out

if __name__ == "__main__":
    for use_prev in (False, True):
        print(f"\n== cue{' + prev_turn' if use_prev else ''}")
        res = run(use_prev=use_prev)
        for key in sorted(res):
            o = res[key]
            s = f"{key[0]:4} {key[1]:6} n={o['n']:3}  any_inject={o['any_inject']/o['n']:.2f}  bullets/cue={o['injected_bullets']/o['n']:.2f}"
            if o["gold"]:
                s += f"  policy_recall={o['gold_hit']/o['gold']:.2f}  cue_hit={o['cue_hit']/o['n']:.2f}  wrong_policy/cue={o['wrong_policy_bullets']/o['n']:.2f}"
            print(s)

# ---- variant B: only high-stakes action classes (irreversible / shared-state actions)
HIGH = {"integrate","review","complete","commit","branch","rewrite_history","stash","deploy","delete",
        "dependency","db_destructive","generated","billing"}

def run_high():
    cues = json.load(open("fixture/cues.json"))
    out = collections.defaultdict(collections.Counter); fires = collections.Counter()
    for c in cues:
        cls = fired(c["cue"]) & HIGH
        inj = {p for p, cs in POLICY.items() if cls & set(cs)}
        gold_pol = {g for g in c["gold"] if g.startswith("p")}
        key = (c["split"], "policy" if c["cat"] == "policy" else ("neg" if not c["gold"] else "other"))
        o = out[key]; o["n"] += 1; o["any"] += bool(inj); o["b"] += len(inj)
        if key[1] == "neg" and inj: fires[tuple(sorted(cls))] += 1
        if gold_pol:
            o["gold"] += len(gold_pol); o["hit"] += len(gold_pol & inj)
            # gold policies whose classes are all non-HIGH are out of this variant's reach
            o["reach"] += sum(1 for g in gold_pol if set(POLICY[g]) & HIGH)
    print("\n== variant B (high-stakes classes only)")
    for k in sorted(out):
        o = out[k]; s = f"{k[0]:4} {k[1]:6} n={o['n']:3} any_inject={o['any']/o['n']:.2f} bullets/cue={o['b']/o['n']:.2f}"
        if o["gold"]: s += f"  recall={o['hit']/o['gold']:.2f}  recall_on_reachable={o['hit']/max(1,o['reach']):.2f} (reachable {o['reach']}/{o['gold']})"
        print(s)
    print("negatives firing, by class set:", fires.most_common(8))

run_high()
