# Funnel JSON score and task diff (docs/research/a15-retrieval.md): hidden and decoys surfaced (delivered or
# ask-cited), planted in the push's packet (pushHanded), and per-task gains and losses against a baseline.
# usage: python3 -I score.py BASE.json RUN.json [RUN2.json ...]
import json, sys
def rows(f):
    return {(t['suite'], t['seed'], t['variant'], t['template']): t for t in json.load(open(f))['perTask']}
def surf(t):
    return bool(t['delivered'] or t.get('askCited'))
base = rows(sys.argv[1])
def line(name, r):
    h = sum(surf(t) for k, t in r.items() if k[2] == 'hidden')
    d = sum(surf(t) for k, t in r.items() if k[2] == 'control')
    ph = sum(bool(t.get('pushHanded')) for k, t in r.items() if k[2] == 'hidden')
    pd = sum(bool(t.get('pushHanded')) for k, t in r.items() if k[2] == 'control')
    nb = sum(t.get('packetBytes', 0) for k, t in r.items() if k[2] == 'neutral')
    nn = sum(1 for k in r if k[2] == 'neutral')
    nb_pk = sum(1 for k, t in r.items() if k[2] == 'neutral' and t.get('packets', 0) > 0)
    ab = [t.get('askBytes', 0) for k, t in r.items() if k[2] == 'hidden']
    print(f"{name:40s} hidden {h}/384 decoys {d}/384 | in packet: planted {ph} decoy {pd} | neutral packets {nb_pk}/{nn} "
          f"bytes {nb} | ask bytes (hidden) {sum(ab)}")
line(sys.argv[1], base)
for f in sys.argv[2:]:
    r = rows(f)
    line(f, r)
    for v in ('hidden', 'control'):
        gain = [k[3] + '/' + str(k[1]) for k in r if k[2] == v and surf(r[k]) and not surf(base[k])]
        loss = [k[3] + '/' + str(k[1]) for k in r if k[2] == v and not surf(r[k]) and surf(base[k])]
        print(f"   {v}: +{len(gain)} {sorted(gain)}\n   {v}: -{len(loss)} {sorted(loss)}")
