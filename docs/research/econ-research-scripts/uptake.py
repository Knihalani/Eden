"""In-sample only (dev + held-out 1-4): uptake and the ask round trip in the eden (ALL) condition, joined to the funnel."""
import json, glob, collections, statistics as s, sys, random

base = sys.argv[1]
INSAMPLE = {'hidden', 'heldout', 'heldout2', 'heldout3', 'heldout4'}
funnel = {}
for t in json.load(open(base + '/funnel-ALL.json'))['perTask']:
    if t['suite'] in INSAMPLE:
        funnel[(t['seed'], t['suite'], t['variant'], t['template'])] = t
cells = collections.defaultdict(list)
for f in sorted(glob.glob(base + '/pi-ALL-4?.json')):
    d = json.load(open(f))
    for r in d['results']:
        if r['condition'] != 'eden':
            continue
        w, suite, tmpl = r['task'].split(':')
        seed = int(w[1:])
        control = suite.endswith('-control')
        suite = suite.replace('-control', '')
        if suite not in INSAMPLE:
            continue
        fu = funnel.get((seed, suite, 'control' if control else 'hidden', tmpl))
        if fu is None:
            continue
        hit = any(r['facts'].values())
        cells[('control' if control else 'hidden', fu['delivered'], r['toolCalls'] > 0)].append(
            (hit, r['wallMs'] / 1000, r['costUsd'] * 1000, r['modelCalls']))
print('variant  delivered asked    n  rate   wall p50  $/1k  calls')
for k in sorted(cells):
    v = cells[k]
    print('%-8s %-9s %-5s %5d %.3f  %6.2f  %.3f  %.2f' % (
        k[0], k[1], k[2], len(v), sum(x[0] for x in v) / len(v), s.median(x[1] for x in v),
        sum(x[2] for x in v) / len(v), sum(x[3] for x in v) / len(v)))
# Does the agent's choice to ask after a delivery depend on the delivery path or the packet's size?
by_why = collections.defaultdict(lambda: [0, 0]); by_chars = collections.defaultdict(lambda: [0, 0])
for f in sorted(glob.glob(base + '/pi-ALL-4?.json')):
    for r in json.load(open(f))['results']:
        w, suite, tmpl = r['task'].split(':')
        if r['condition'] != 'eden' or suite not in INSAMPLE:
            continue
        fu = funnel.get((int(w[1:]), suite, 'hidden', tmpl))
        if not fu or not fu['delivered']:
            continue
        a = by_why[fu['why']]; a[0] += 1; a[1] += r['toolCalls'] > 0
        b = by_chars[min(3, r['injectedChars'] // 200)]; b[0] += 1; b[1] += r['toolCalls'] > 0
print('P(ask | delivered) by path:', {k: '%d/%d' % (v[1], v[0]) for k, v in by_why.items()})
print('P(ask | delivered) by packet chars //200 (3 = 600+):',
      {k: '%d/%d' % (v[1], v[0]) for k, v in sorted(by_chars.items())})
for variant in ('hidden', 'control'):
    for dl in (True, False):
        v = cells[(variant, dl, True)] + cells[(variant, dl, False)]
        rate = sum(x[0] for x in v) / max(1, len(v))
        print(variant, 'delivered' if dl else 'not delivered', 'n', len(v), 'rate %.3f' % rate)
