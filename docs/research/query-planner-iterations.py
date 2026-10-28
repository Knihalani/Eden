"""Summarises query-planner-iterations.jsonl: per iteration, profile and label, pooled over seeds."""
import collections, json, math, sys

def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return f"{100 * p:.1f}% ({100 * (c - h):.0f}-{100 * (c + h):.0f})"

groups = collections.defaultdict(list)
for line in open(sys.argv[1]):
    r = json.loads(line)
    groups[(r["iteration"], r["judge"], r["profile"], r["label"])].append(r)
print("| Iteration | Judge | Mix | Run | Seeds | Needed facts retrieved or cached | Recall | Precision | False fires | Source calls per lookup | Secrets leaked |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for (it, judge, profile, label), rs in sorted(groups.items()):
    c = [r["overall"]["counts"] for r in rs]
    must = sum(x["mustFacts"] for x in c)
    calls = sum(r["sources"]["callsPerLookup"] * r["sources"]["lookups"] for r in rs)
    lookups = sum(r["sources"]["lookups"] for r in rs)
    rel = sum(x["relevant"] for x in c)
    delivered = sum(r["overall"]["delivered"] for r in rs)
    print(
        f"| {it} | {judge} | {profile} | {label} | {len(rs)} | {wilson(sum(r['funnel']['retrievedOrCached'] for r in rs), must)} "
        f"| {wilson(sum(x['mustDelivered'] for x in c), must)} | {rel / max(1, delivered):.3f} ({rel}/{delivered}) "
        f"| {sum(x['falseFires'] for x in c)}/{sum(x['silentTurns'] for x in c)} | {calls / lookups:.2f} "
        f"| {sum(r['privacy']['secretsLeaked'] for r in rs)}/{sum(r['privacy']['secretsPlanted'] for r in rs)} |"
    )
