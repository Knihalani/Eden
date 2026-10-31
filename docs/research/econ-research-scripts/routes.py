"""Which OpenRouter endpoint served each agent request (inferred from its reported cost), by condition, and its speed."""
import json, glob, collections, statistics as s, sys

base = sys.argv[1]
# Endpoint prices for z-ai/glm-5.3-flash, OpenRouter endpoints API, queried 2026-10-31 ($ per token).
cands = {'OpenInference': (1.72e-8, 3.55e-8), 'Relace': (1.63e-8, 1.479e-7), 'Morph': (4.2e-8, 3e-7),
         'Wafer-us': (4.4e-8, 2e-7), 'Wafer': (5.4e-8, 2e-7), 'Darkbloom': (6.5e-8, 1.8e-7),
         'GMI': (7.5e-8, 2.5e-7), 'NearAI': (8e-8, 5e-7), 'Novita': (8.4e-8, 2.8e-7), 'StreamLake': (8.85e-8, 2.95e-7),
         'InferenceNet': (1.08e-7, 3.5e-7), 'Phala/DO': (1.125e-7, 3.75e-7), 'CoreWeave': (1.2e-7, 3.8e-7),
         'list-0.15/0.50': (1.5e-7, 5e-7)}
by = collections.defaultdict(collections.Counter)
speed = collections.defaultdict(list)
ttft = collections.defaultdict(list)
cost_by = collections.defaultdict(float)
n_by = collections.Counter()
for f in sorted(glob.glob(base + '/pi-ALL-*.timeline/tasks.jsonl') + glob.glob(base + '/pi-H-*.timeline/tasks.jsonl')):
    cfg = f.split('/')[-2].split('-')[1]
    for l in open(f):
        t = json.loads(l)
        cond = cfg + ':' + t['condition']
        for r in t.get('requests', []):
            i, o, c = r.get('in'), r.get('out'), r.get('cost')
            if not (i and o and c):
                continue
            best = min(cands, key=lambda k: abs(i * cands[k][0] + o * cands[k][1] - c) / c)
            err = abs(i * cands[best][0] + o * cands[best][1] - c) / c
            ep = best if err < 0.03 else 'unmatched'
            by[cond][ep] += 1
            dur = r['endMs'] - r['startMs'] - r['firstTokenMs']
            if o >= 100:
                speed[ep].append(dur / o)
            ttft[ep].append(r['firstTokenMs'])
            cost_by[cond] += c; n_by[cond] += 1
print('endpoint share by condition (top 5):')
for cond in sorted(by):
    tot = sum(by[cond].values())
    print(' %-14s n=%5d $/req %.3g ' % (cond, tot, cost_by[cond] / n_by[cond]) +
          ', '.join('%s %.2f' % (k, v / tot) for k, v in by[cond].most_common(5)))
print('speed by endpoint (ms per output token after first token, p50; TTFT p50; n):')
for ep in sorted(speed, key=lambda e: -len(speed[e])):
    if len(speed[ep]) > 50:
        print(' %-16s %.2f ms/tok  ttft %d ms  n=%d' % (ep, s.median(speed[ep]), s.median(ttft[ep]), len(speed[ep])))
