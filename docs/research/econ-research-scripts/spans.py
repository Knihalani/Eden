"""Duration of each Eden span kind in the eden condition (ALL), and how many end before the first model request."""
import json, glob, collections, statistics as s, sys

base = sys.argv[1]
dur = collections.defaultdict(list)
before = collections.Counter()
for f in sorted(glob.glob(base + '/pi-ALL-*.timeline/tasks.jsonl')):
    for l in open(f):
        t = json.loads(l)
        if t['condition'] != 'eden':
            continue
        reqs = t.get('requests', [])
        first = reqs[0]['startMs'] if reqs else 0
        opened = {}
        for e in t.get('events', []):
            if e.get('ph') == 'B':
                opened[e['id']] = (e['ev'], e['t'], e.get('lane'))
            elif e.get('ph') == 'E' and e.get('id') in opened:
                ev, t0, lane = opened.pop(e['id'])
                key = '%s[%s]' % (ev, lane)
                dur[key].append(e['t'] - t0)
                if e['t'] <= first + 1:
                    before[key] += 1
for k in sorted(dur, key=lambda k: -s.median(dur[k])):
    d = sorted(dur[k])
    print('%-34s n=%5d p50 %7.1f ms p90 %7.1f ms  ended before first request %d' % (
        k, len(d), s.median(d), d[int(len(d) * .9)], before[k]))
