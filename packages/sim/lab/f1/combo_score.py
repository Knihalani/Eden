"""F1 x F2 combined check-pool pilot scorer (subagent-simulated; docs/research/f1-intent-bridge.md section 9).
Reads .local/f1/combo/prompts.json and ans-*.jsonl; applies the pre-registered rule: pass iff an added fact
(planted, not in base, in arm) is named in >=50%, an added look-alike <=25%, neutral any-named (majority of the
repeats) <= +3 points over base."""
import collections, glob, json, re, sys

D = sys.argv[1] if len(sys.argv) > 1 else ".local/f1/combo"
P = {p["id"]: p for p in json.load(open(f"{D}/prompts.json"))["prompts"]}
A = {}
for f in glob.glob(f"{D}/ans-*.jsonl"):
    for l in open(f):
        try:
            o = json.loads(l)
        except Exception:
            continue
        A[str(o.get("id"))] = o.get("reply")
NOHIT = re.compile(r"^\s*(?:(?:none|n/a)(?![\w]).*|(?:nothing|no)?\s*\.?\s*)$", re.I | re.S)


def named(p, reply):
    if isinstance(reply, str):
        try:
            reply = json.loads(reply)
        except Exception:
            return None
    if not isinstance(reply, dict):
        return None
    out = set()
    for e in reply.get("items", []) or []:
        try:
            i = int(e.get("i")) - 1
            hits = str(e.get("hits", ""))
            act = e.get("act") is True
        except Exception:
            continue
        if act and not NOHIT.match(hits) and 0 <= i < len(p["ids"]):
            out.add(p["ids"][i])
    return out


c = collections.Counter()
miss = 0
neu = collections.defaultdict(lambda: collections.defaultdict(list))  # key -> arm -> [any]
for i, p in P.items():
    if i not in A:
        miss += 1
        continue
    n = named(p, A[i])
    if n is None:
        c["unreadable"] += 1
        continue
    if p["variant"] == "neutral":
        for arm in p["arms"]:
            neu[p["key"]][arm].append(len(n) > 0)
    else:
        for arm in ("a", "b"):
            if arm in p["arms"]:
                c[(p["variant"], arm, "n")] += 1
                c[(p["variant"], arm, "named")] += p["planted"] in n
print(f"prompts {len(P)} answered {len(P) - miss} unreadable {c['unreadable']}")
for v in ("hidden", "control"):
    for arm in ("a", "b"):
        n = c[(v, arm, "n")]
        print(f"{v:8s} arm {arm}: planted named {c[(v, arm, 'named')]}/{n}" + (f" = {c[(v, arm, 'named')] / n:.0%}" if n else ""))
maj = lambda xs: sum(xs) * 2 > len(xs)
tasks = [k for k, v in neu.items() if all(a in v for a in ("base", "a", "b"))]
res = {}
for arm in ("base", "a", "b"):
    res[arm] = sum(maj(neu[k][arm]) for k in tasks)
print(f"neutral tasks {len(tasks)}: any named (majority) base {res['base']} a {res['a']} b {res['b']}")
for arm in ("a", "b"):
    up = sum(maj(neu[k][arm]) and not maj(neu[k]["base"]) for k in tasks)
    down = sum(maj(neu[k]["base"]) and not maj(neu[k][arm]) for k in tasks)
    print(f"  {arm} vs base: +{up} -{down}, delta {(res[arm] - res['base']) / max(1, len(tasks)) * 100:+.1f} pts")
for arm in ("a", "b"):
    hn, cn = c[("hidden", arm, "n")], c[("control", arm, "n")]
    h = c[("hidden", arm, "named")] / hn if hn else 0
    k = c[("control", arm, "named")] / cn if cn else 0
    d = (res[arm] - res["base"]) / max(1, len(tasks)) * 100
    ok = h >= 0.5 and k <= 0.25 and d <= 3
    print(f"RULE arm {arm}: fact {h:.0%} (>=50%) look-alike {k:.0%} (<=25%) neutral {d:+.1f} (<=+3) -> {'PASS' if ok else 'FAIL'}")
