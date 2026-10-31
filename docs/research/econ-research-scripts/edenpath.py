"""Eden's share of the critical path: time from task start to the first model request, and observe spans."""
import json, glob, collections, statistics as s, sys

base = sys.argv[1]
first_req = collections.defaultdict(list)
observe = collections.defaultdict(list)
asked = collections.Counter(); tot = collections.Counter()
out_first = collections.defaultdict(list); out_last = collections.defaultdict(list)
for f in sorted(glob.glob(base + '/pi-ALL-*.timeline/tasks.jsonl') + glob.glob(base + '/pi-H-*.timeline/tasks.jsonl')):
    cfg = f.split('/')[-2].split('-')[1]
    for l in open(f):
        t = json.loads(l)
        k = cfg + ':' + t['condition']
        reqs = t.get('requests', [])
        if reqs:
            first_req[k].append(reqs[0]['startMs'])
            if len(reqs) > 1:
                out_first[k].append(sum(r['out'] for r in reqs[:-1]))
            out_last[k].append(reqs[-1]['out'])
        opened = {}
        for e in t.get('events', []):
            if e.get('ev') == 'eden.observe' and e.get('ph') == 'B':
                opened[e['id']] = e['t']
            elif e.get('ev') == 'eden.observe' and e.get('ph') == 'E' and e['id'] in opened:
                observe[k].append(e['t'] - opened[e['id']])
        tot[k] += 1
        if any(e.get('ev', '').startswith('tool') and 'ask' in json.dumps(e.get('data', {})) for e in t.get('events', [])):
            asked[k] += 1
for k in sorted(first_req):
    fr = first_req[k]
    print('%-15s first model request at p50 %.0f ms p90 %.0f ms; observe span p50 %.0f ms; asked %.2f; '
          'out before final p50 %s; final out p50 %.0f' % (
              k, s.median(fr), sorted(fr)[int(len(fr) * .9)], s.median(observe[k]) if observe[k] else -1,
              asked[k] / tot[k], s.median(out_first[k]) if out_first[k] else '-', s.median(out_last[k])))
