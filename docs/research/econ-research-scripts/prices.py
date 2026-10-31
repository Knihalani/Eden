import json, glob, collections, statistics as s, sys
import numpy as np

base = sys.argv[1]
rows = []
for f in glob.glob(base + '/pi-ALL-*.timeline/tasks.jsonl') + glob.glob(base + '/pi-H-*.timeline/tasks.jsonl'):
    for l in open(f):
        t = json.loads(l)
        for r in t.get('requests', []):
            if r.get('cost') and r.get('in'):
                rows.append((r['in'], r['out'], r['cost'], r['firstTokenMs'], r['endMs'] - r['startMs'], t['condition']))
print('requests', len(rows))
cands = {'OpenInference': (1.72e-8, 3.55e-8), 'Relace': (1.63e-8, 1.479e-7), 'Morph': (4.2e-8, 3e-7),
         'Wafer-us': (4.4e-8, 2e-7), 'Wafer': (5.4e-8, 2e-7), 'Z.AI/std': (1.5e-7, 5e-7), 'Novita': (8.4e-8, 2.8e-7),
         'GMI': (7.5e-8, 2.5e-7), 'Darkbloom': (6.5e-8, 1.8e-7), 'NearAI': (8e-8, 5e-7)}
cnt = collections.Counter()
for i, o, c, *_ in rows:
    best = min(cands, key=lambda k: abs(i * cands[k][0] + o * cands[k][1] - c) / c)
    err = abs(i * cands[best][0] + o * cands[best][1] - c) / c
    cnt[best if err < 0.03 else 'other'] += 1
print(cnt.most_common())
agg = collections.defaultdict(lambda: [0, 0, 0, 0])
for i, o, c, ft, d, cond in rows:
    a = agg[cond]; a[0] += i; a[1] += o; a[2] += c; a[3] += 1
for k, v in agg.items():
    print(k, 'req', v[3], 'in/req', v[0] // v[3], 'out/req', v[1] // v[3], '$/req %.3g' % (v[2] / v[3]))
X = np.array([[r[0], r[1]] for r in rows]); y = np.array([r[2] for r in rows])
p = np.linalg.lstsq(X, y, rcond=None)[0]
print('effective $/M in %.4f out %.4f ratio %.2f' % (p[0] * 1e6, p[1] * 1e6, p[1] / p[0]))
tin = sum(r[0] for r in rows); tout = sum(r[1] for r in rows)
print('share of cost from input at fitted prices %.2f' % (tin * p[0] / (tin * p[0] + tout * p[1])))
X = np.array([[1, r[1], r[0]] for r in rows]); y = np.array([r[4] for r in rows])
print('dur ms = a + b*out + c*in', np.linalg.lstsq(X, y, rcond=None)[0])
print('ttft p50', s.median(r[3] for r in rows))
print('in tokens per request p50', s.median(r[0] for r in rows), 'share >=1024', sum(r[0] >= 1024 for r in rows) / len(rows))
