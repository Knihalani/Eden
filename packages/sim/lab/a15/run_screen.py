# Drives screen.py's retrievers (docs/research/a15-retrieval.md section 2). Each adds up to k items the push did not
# hand (the pool dump's handed ids), as one extra candidate slot would.
# usage: python3 -I run_screen.py CORPUS.jsonl FUNNEL.json POOL.jsonl [EMB_DIR]
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from screen import *
import numpy as np

corpus, funnel, pooldump = sys.argv[1:4]
embdir = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != '-' else ''
# A requests file written with `cards-enrich --general` (`q`: how many of `r` are the item's own).
genfile = sys.argv[5] if len(sys.argv) > 5 else ''
OWN, GEN = {}, {}
if genfile:
    for l in open(genfile):
        x = json.loads(l)
        q = x.get('q', len(x['r']))
        OWN[x['h']], GEN[x['h']] = x['r'][:q], x['r'][q:]
pt, worlds = load(corpus, funnel)
handed = {}
for l in open(pooldump):
    r = json.loads(l)
    handed[(r['suite'], r['seed'], r['variant'], r['template'])] = {p['id'] for p in r['pool'] if p.get('handed')}


def prep(w, ctx):
    if 'bm' in ctx:
        return
    docs = [terms(x['title'] + ' ' + x['text']) for x in w['items']]
    ctx['bm'] = BM25(docs)
    ctx['spans'] = [spans(x['title'] + ' ' + x['text'][:1200]) for x in w['items']]
    if genfile:
        ctx['gen'] = BM25([terms(' '.join(GEN.get(x['h'], []))) for x in w['items']])
        ctx['own'] = BM25([terms(' '.join(OWN.get(x['h'], []))) for x in w['items']])
    if embdir:
        z = np.load(f"{embdir}/{w['suite']}-{w['seed']}-{w['variant']}.npz")
        ctx['E'], ctx['Q'] = z['E'], z['Q']


def ranked(w, task, ctx, score, keep=lambda i: True):
    hd = handed.get((w['suite'], w['seed'], w['variant'], task['template']), set())
    order = sorted(range(len(w['items'])), key=lambda i: -score[i])
    return [w['items'][i]['id'] for i in order if score[i] > 0 and keep(i) and w['items'][i]['id'] not in hd]


def r_bm25(w, task, ctx):
    prep(w, ctx)
    return ranked(w, task, ctx, ctx['bm'].scores(terms(task['request'])))


def r_date(w, task, ctx):
    prep(w, ctx)
    rd = request_days(task['request'])
    if not rd:
        return []
    s = ctx['bm'].scores(terms(task['request']))
    return ranked(w, task, ctx, s, lambda i: overlaps(ctx['spans'][i], rd))


def r_emb(w, task, ctx, need_date=False, floor=-1):
    prep(w, ctx)
    qi = [t['template'] for t in w['tasks']].index(task['template'])
    sims = ctx['E'] @ ctx['Q'][qi]
    rd = request_days(task['request']) if need_date else None
    if need_date and not rd:
        return []
    keep = (lambda i: overlaps(ctx['spans'][i], rd)) if need_date else (lambda i: True)
    s = [x - floor if x > floor else 0 for x in sims]
    return ranked(w, task, ctx, s, keep)


def r_req(w, task, ctx, which, need=2):
    prep(w, ctx)
    q = terms(task['request'])
    s = ctx[which].scores(q)
    docs = ctx[which].docs
    # At least `need` request terms among the item's requests, as the intent index asks for two.
    return ranked(w, task, ctx, s, lambda i: sum(1 for t in set(q) if t in docs[i]) >= need)


evaluate('bm25 (lexical, sanity)', pt, worlds, r_bm25)
if genfile:
    for need in (1, 2, 3):
        evaluate(f'general requests, >= {need} terms', pt, worlds, lambda w, t, c: r_req(w, t, c, 'gen', need))
    evaluate('own requests (new sample), >= 2 terms', pt, worlds, lambda w, t, c: r_req(w, t, c, 'own', 2))
evaluate('date window + bm25', pt, worlds, r_date)
if embdir:
    evaluate('embedding', pt, worlds, r_emb)
    evaluate('embedding, date window required', pt, worlds, lambda w, t, c: r_emb(w, t, c, True))


# Re-rank the push's 15-item pool (the pool dump's order), hand the first 5: planted and decoys in the packet.
pools = {}
for l in open(pooldump):
    r = json.loads(l)
    pools[(r['suite'], r['seed'], r['variant'], r['template'])] = [p['id'] for p in r['pool']]


def rerank(name, score_fn, K=5):
    c = collections.Counter()
    for w in worlds:
        if w['variant'] not in ('hidden', 'control'):
            continue
        ctx = {}
        prep(w, ctx)
        idx = {x['id']: i for i, x in enumerate(w['items'])}
        for task in w['tasks']:
            key = (w['suite'], w['seed'], w['variant'], task['template'])
            pool = pools.get(key)
            f = pt.get(key)
            if not pool or not f:
                continue
            sc = score_fn(w, task, ctx, [idx[i] for i in pool if i in idx])
            order = [pool[j] for j in sorted(range(len(pool)), key=lambda j: (-sc[j], j))]
            was, now = task['planted'] in pool[:K], task['planted'] in order[:K]
            c[w['variant'] + ' before'] += was
            c[w['variant'] + ' after'] += now
            c[w['variant'] + ' +'] += now and not was
            c[w['variant'] + ' -'] += was and not now
            c[w['variant'] + ' + unsurfaced'] += now and not was and not surfaced(f)
    print(f"{name:42s} planted in first {K} {c['hidden before']} -> {c['hidden after']} (+{c['hidden +']} "
          f"-{c['hidden -']}, +{c['hidden + unsurfaced']} never surfaced); decoys {c['control before']} -> "
          f"{c['control after']} (+{c['control +']} -{c['control -']}, +{c['control + unsurfaced']})")


def rrf(*ranks):
    return [sum(1 / (60 + r[j]) for r in ranks) for j in range(len(ranks[0]))]


def rank_of(vals):
    order = sorted(range(len(vals)), key=lambda j: -vals[j])
    out = [0] * len(vals)
    for r, j in enumerate(order):
        out[j] = r if vals[j] > 0 else len(vals)
    return out


def s_pool(w, t, ctx, ii):
    return [-j for j in range(len(ii))]


def s_intent(w, t, ctx, ii, which='own'):
    q = terms(t['request'])
    s = ctx[which].scores(q)
    return rrf(list(range(len(ii))), rank_of([s[i] for i in ii]))


def s_date(w, t, ctx, ii):
    rd = request_days(t['request'])
    hit = [1 if rd and overlaps(ctx['spans'][i], rd) else 0 for i in ii]
    return rrf(list(range(len(ii))), rank_of(hit))


def s_both(w, t, ctx, ii):
    q = terms(t['request'])
    s = ctx['own'].scores(q)
    rd = request_days(t['request'])
    hit = [1 if rd and overlaps(ctx['spans'][i], rd) else 0 for i in ii]
    return rrf(list(range(len(ii))), rank_of([s[i] for i in ii]), rank_of(hit))


rerank('pool order (sanity)', s_pool)
if genfile:
    rerank('pool + intent requests (rrf)', s_intent)
    rerank('pool + general requests (rrf)', lambda w, t, c, ii: s_intent(w, t, c, ii, 'gen'))
    rerank('pool + intent + date (rrf)', s_both)
rerank('pool + date (rrf)', s_date)


def interleave(*fns):
    def go(w, t, c):
        lists = [f(w, t, c) for f in fns]
        out = []
        for i in range(max(map(len, lists), default=0)):
            for l in lists:
                if i < len(l) and l[i] not in out:
                    out.append(l[i])
        return out
    return go


if genfile:
    evaluate('intent top + date window (interleaved)', pt, worlds,
             interleave(lambda w, t, c: r_req(w, t, c, 'own', 2), r_date), ks=(1, 2, 3))
