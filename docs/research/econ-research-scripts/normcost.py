"""Agent cost per 1k tasks by condition: as billed (mixed routing) and re-priced at one fixed endpoint price."""
import json, glob, collections, sys

base = sys.argv[1]
fixed = {'Z.AI list 0.15/0.50': (1.5e-7, 5e-7), 'Wafer-us 0.044/0.20': (4.4e-8, 2e-7)}
agg = collections.defaultdict(lambda: [0, 0, 0.0, 0, 0])  # in, out, billed, tasks, calls
for f in sorted(glob.glob(base + '/pi-ALL-*.timeline/tasks.jsonl') + glob.glob(base + '/pi-H-*.timeline/tasks.jsonl')):
    cfg = f.split('/')[-2].split('-')[1]
    for l in open(f):
        t = json.loads(l)
        a = agg[cfg + ':' + t['condition']]
        a[3] += 1
        for r in t.get('requests', []):
            a[0] += r.get('in') or 0; a[1] += r.get('out') or 0; a[2] += r.get('cost') or 0; a[4] += 1
print('%-15s %6s %6s %6s %6s %9s %s' % ('condition', 'tasks', 'calls', 'in', 'out', 'billed', '  '.join(fixed)))
for k in sorted(agg):
    i, o, c, n, calls = agg[k]
    rep = '  '.join('%.3f' % ((i * p[0] + o * p[1]) / n * 1000) for p in fixed.values())
    print('%-15s %6d %6.2f %6d %6d %9.3f %s' % (k, n, calls / n, i / n, o / n, c / n * 1000, rep))
