"""M7 (D930): the push check's pre-screen, trained and screened offline (docs/research/m7-prescreen.md).

Rows come from `bun run funnel ... -- --check live|replay --prescreen-dump F` (prescreen-dump.ts): one check call as
the engine made it (request, day, the pool's items as the check read them, the gate's flags) and the check's answer.
`tag-dump.ts` writes the constraint tagger's logits beside each dump (`F.tags.jsonl`).

The pre-screen settles a pool or abstains:
  silent  when every item's P(the check names it) is under t_silent        -> verdict {} (no packet)
  pass    when exactly one item is over t_pass and every other under t_low -> verdict {that item}
Thresholds are chosen out of fold on the training families only (grouped by template), to keep out-of-fold
disagreement under --target; the held-out families (train5-6 unless --heldout) are read once with them.

  python3 -I packages/sim/lab/m7/m7.py --dumps '.local/m7/dump-*.jsonl' --model h1
"""

import argparse
import glob
import json
import math
import re
import sys
import zlib

import numpy as np

STOP = set(
    """a an the and or but if then than to of in on at by for from with without into onto over under about after before
    this that these those it its is are was were be been being am do does did done have has had having can could will
    would shall should may might must i me my mine we us our ours you your yours he him his she her hers they them their
    what which who whom whose when where why how all any each every some no not nor only own same so too very just also
    please let lets let's ok okay hi hello thanks thank up out off again once here there now today tomorrow yesterday
    want need like get got make made go going send move book pay add set put take give tell ask check sure one two""".split()
)
WORD = re.compile(r"[a-z0-9£$€]+")
RAW = re.compile(r"[A-Za-z0-9£$€][A-Za-z0-9£$€'’\-]*")
DAYS = set("monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun".split())
MONTHS = set(
    "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split()
)
BLOCK = [
    "cancel",
    "closed",
    "close",
    "hold",
    "frozen",
    "freeze",
    "suspend",
    "block",
    "until",
    "deadline",
    "limit",
    "cap",
    "maximum",
    "max",
    "only",
    "must",
    "required",
    "require",
    "approval",
    "sign-off",
    "signoff",
    "already",
    "booked",
    "paid",
    "used",
    "conflict",
    "clash",
    "unavailable",
    "away",
    "leave",
    "strike",
    "dispute",
    "notice",
    "policy",
    "rule",
    "not",
    "no",
    "never",
    "don't",
    "do not",
    "pending",
    "overdue",
    "expire",
    "expired",
    "moved",
    "postpone",
    "changed",
    "instead",
    "allergic",
    "allergy",
    "banned",
    "stop",
    "pause",
]
CLEAR = [
    "lifted",
    "resolved",
    "reopen",
    "approved",
    "granted",
    "settled",
    "called off",
    "back to normal",
    "finished",
    "ended",
    "no longer",
    "restored",
    "cleared",
    "go ahead",
    "all clear",
    "confirmed",
    "fine to",
    "ok to",
    "resumed",
    "complete",
]
SOURCES = ["gmail", "calendar", "gdrive", "docs", "crm", "hubspot", "slack", "chat", "notes", "whatsapp", "bank"]


def crc(s):
    return zlib.crc32(s.encode("utf-8"))


def words(text):
    return WORD.findall(text.lower())


def content(text):
    return [w for w in words(text) if len(w) >= 3 and w not in STOP and not w.isdigit()]


def names(text):
    toks = RAW.findall(text)
    out = set()
    for k, t in enumerate(toks):
        if k == 0:
            continue
        if t[:1].isupper() and t.lower() not in STOP and t.lower() not in DAYS and t.lower() not in MONTHS:
            out.add(t.lower().strip("'’"))
    return out


def numbers(text):
    return set(re.findall(r"\d[\d,.:]*\d|\d", text))


def dayrefs(text):
    ws = set(words(text))
    return (ws & DAYS) | (ws & MONTHS)


def day_index(s):
    # "2026-10-27" or "2026-10-27T09:00" -> days since epoch (approx, for deltas only)
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s or "")
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    return y * 372 + mo * 31 + d


def lexcount(text, lex):
    t = " " + text.lower() + " "
    return sum(t.count(w) for w in lex)


def load(patterns, need_tags=True):
    rows = []
    for pat in patterns:
        for f in sorted(glob.glob(pat)):
            if f.endswith(".tags.jsonl"):
                continue
            tf = f[: -len(".jsonl")] + ".tags.jsonl"
            try:
                tags = [json.loads(l) for l in open(tf) if l.strip()]
            except FileNotFoundError:
                if need_tags:
                    sys.exit(f"missing {tf}: run tag-dump.ts first")
                tags = None
            k = 0
            for line in open(f):
                if not line.strip():
                    continue
                r = json.loads(line)
                if tags is not None:
                    r["tagl"] = tags[k]["logits"]
                k += 1
                if r.get("yes") is None or not r.get("items"):
                    continue
                rows.append(r)
    return rows


def suite_of(r):
    return r.get("suite", "")


def family(r):
    return f"{re.sub(r'(rw|r)$', '', suite_of(r))}/{r.get('template', '')}"


def softmax(l):
    m = max(l)
    e = [math.exp(x - m) for x in l]
    s = sum(e)
    return [x / s for x in e]


ALLCLEAR = {1, 2, 3, 4, 5, 6, 8}  # superseded, other-entity, resolved, other-period, already-met, neutral, twin


def item_rows(r):
    """Per item feature vectors (H1, the symbolic lattice) and labels."""
    req = r["request"]
    rc = set(content(req))
    rn = names(req)
    rnum = numbers(req)
    rday = dayrefs(req)
    today = day_index(r["today"])
    items = r["items"]
    like = r.get("like") or [True] * len(items)
    texts = [f"{it['title']} {it['text']}" for it in items]
    icont = [set(content(t)) for t in texts]
    df = {}
    for s in icont:
        for w in s & rc:
            df[w] = df.get(w, 0) + 1
    over = []
    for s in icont:
        sh = s & rc
        over.append(sum(1.0 / df[w] for w in sh))
    order = sorted(range(len(items)), key=lambda i: -over[i])
    orank = {i: k for k, i in enumerate(order)}
    nlike = sum(1 for x in like if x)
    tagl = r.get("tagl")
    cprob = []
    for i in range(len(items)):
        if tagl:
            p = softmax(tagl[i])
            # As TagMemo holds it: one probability in 1/255 steps (the engine has no logits).
            cprob.append(round((1 - sum(p[k] for k in ALLCLEAR)) * 255) / 255)
        else:
            cprob.append(0.5)
    maxc_like = max([cprob[i] for i in range(len(items)) if like[i]] or [0])
    maxover = max(over) if over else 0
    yes = set(r["yes"])
    feats, labels = [], []
    likerank = 0
    for i, it in enumerate(items):
        t = texts[i]
        tl = t.lower()
        sh = icont[i] & rc
        title_c = set(content(it["title"]))
        idx = day_index(it.get("date", ""))
        delta = (idx - today) if (idx is not None and today is not None) else 0
        tn = names(t) | set(w for w in words(t))
        f = [
            i,
            len(items),
            1 if like[i] else 0,
            nlike,
            likerank if like[i] else -1,
            SOURCES.index(it["source"]) if it["source"] in SOURCES else len(SOURCES),
            1 if it.get("from") else 0,
            max(-400, min(400, delta)),
            len(sh),
            len(sh) / max(1, len(rc)),
            len(title_c & rc),
            over[i],
            orank[i],
            over[i] / maxover if maxover else 0,
            len(rn & tn),
            len(rn),
            len(rnum & numbers(t)),
            len(rnum),
            len(rday & dayrefs(t)),
            len(rday),
            lexcount(tl, BLOCK),
            lexcount(tl, CLEAR),
            len(t),
            len(rc),
            cprob[i],
            maxc_like,
            1 if "unsubscribe" in tl or "newsletter" in tl or "noreply" in tl else 0,
        ]
        if like[i]:
            likerank += 1
        feats.append(f)
        labels.append(1 if it["id"] in yes else 0)
    return feats, labels


FEATURE_NAMES = (
    "rank n like nlike likerank source hasfrom delta shared sharedfrac titleshared overlap overrank overrel "
    "names rnames nums rnums days rdays block clear len rlen cprob maxclike bulk"
).split()


def matrix(rows):
    X, Y, G = [], [], []
    for gi, r in enumerate(rows):
        f, y = item_rows(r)
        X += f
        Y += y
        G += [gi] * len(y)
    return np.array(X, dtype=np.float32), np.array(Y, dtype=np.int8), np.array(G)


def settle(p_items, ts, tp, tl):
    """One pool's verdict from per-item probabilities: [] silent, [i] pass, None abstain."""
    mx = max(p_items)
    if mx < ts:
        return []
    hi = [i for i, p in enumerate(p_items) if p >= tp]
    if len(hi) == 1 and all(p < tl for i, p in enumerate(p_items) if i != hi[0]):
        return hi
    return None


def score_rule(pools, ts, tp, tl):
    """pools: list of (probs, yes_index_set). Returns settled, disagreements, silent settled, pass settled."""
    n = settled = bad = sil = pas = 0
    for probs, yes in pools:
        n += 1
        v = settle(probs, ts, tp, tl)
        if v is None:
            continue
        settled += 1
        if v:
            pas += 1
        else:
            sil += 1
        if set(v) != yes:
            bad += 1
    return n, settled, bad, sil, pas


def pick(pools, target):
    """The thresholds that settle most pools with disagreement (bad / settled) at most `target`."""
    best = (0.0, 2.0, 2.0)
    best_n = -1
    # Silence is decided on a pool's highest item: sweep the pools' maxima (just above each).
    maxes = np.array(sorted(max(probs) for probs, _ in pools))
    qs = np.unique(np.quantile(maxes, np.linspace(0, 1, 201))) + 1e-7 if len(maxes) else [0.5]
    for ts in [0.0] + list(qs):
        n, s, b, sil, pas = score_rule(pools, ts, 2.0, 2.0)
        if s and b / s > target:
            continue
        for tp in [2.0, 0.995, 0.99, 0.98, 0.97, 0.95, 0.9, 0.85, 0.8]:
            for tl in [0.005, 0.01, 0.02, 0.05, 0.1, 0.2]:
                if tp > 1 and tl != 0.005:
                    continue
                n2, s2, b2, _, _ = score_rule(pools, ts, tp, tl)
                if s2 and b2 / s2 <= target and s2 > best_n:
                    best_n, best = s2, (float(ts), tp, tl)
    return best


def curve(pools, fracs=(0.1, 0.2, 0.3, 0.4)):
    """Threshold-free: the disagreement when the pools with the lowest top item are settled silent, at each share."""
    mx = np.array([max(pr) for pr, _ in pools])
    silent = np.array([len(y) == 0 for _, y in pools])
    order = np.argsort(mx, kind="stable")
    out = []
    for f in fracs:
        k = max(1, int(f * len(pools)))
        out.append((f, float((~silent[order[:k]]).mean())))
    return out


def curve_line(pools):
    return "curve (settled share: disagreement) " + ", ".join(f"{f:.0%}: {d:.1%}" for f, d in curve(pools))


def pools_of(rows, probs, groups):
    out = []
    for gi, r in enumerate(rows):
        idx = np.where(groups == gi)[0]
        yes = set(k for k, it in enumerate(r["items"]) if it["id"] in set(r["yes"]))
        out.append(([float(x) for x in probs[idx]], yes))
    return out


def fit_gbm(X, Y, args):
    import lightgbm as lgb

    m = lgb.LGBMClassifier(
        n_estimators=args.trees,
        num_leaves=args.leaves,
        learning_rate=0.05,
        min_child_samples=10,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        verbose=-1,
    )
    m.fit(X, Y)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dumps", nargs="+", required=True)
    ap.add_argument("--heldout", default="train5,train6")
    ap.add_argument("--extra-eval", nargs="*", default=[], help="dump globs read only as more held-out families")
    ap.add_argument("--model", default="h1")
    ap.add_argument("--target", type=float, default=0.006)
    ap.add_argument("--trees", type=int, default=300)
    ap.add_argument("--leaves", type=int, default=15)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--no-tags", action="store_true")
    ap.add_argument("--drop", default="", help="comma-separated feature names to zero (ablation)")
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    rows = load(args.dumps, need_tags=not args.no_tags)
    held = set(args.heldout.split(","))
    base = lambda r: re.sub(r"(rw|r)$", "", suite_of(r))
    tr = [r for r in rows if base(r) not in held]
    te = [r for r in rows if base(r) in held]
    print(f"rows {len(rows)}: train {len(tr)} held-out {len(te)}; held-out silent {sum(1 for r in te if not r['yes'])}")
    Xtr, Ytr, Gtr = matrix(tr)
    Xte, Yte, Gte = matrix(te)
    drop = [FEATURE_NAMES.index(n) for n in args.drop.split(",") if n]
    if args.no_tags:
        drop += [FEATURE_NAMES.index(n) for n in ["cprob", "maxclike"]]
    for d in drop:
        Xtr[:, d] = 0
        Xte[:, d] = 0
    # Out-of-fold probabilities on train, grouped by family (template), to choose thresholds.
    fams = sorted(set(family(r) for r in tr))
    rng = np.random.default_rng(0)
    rng.shuffle(fams)
    fold_of = {f: k % args.folds for k, f in enumerate(fams)}
    pool_fold = np.array([fold_of[family(r)] for r in tr])
    oof = np.zeros(len(Ytr), dtype=np.float32)
    for k in range(args.folds):
        tr_idx = np.where(pool_fold[Gtr] != k)[0]
        va_idx = np.where(pool_fold[Gtr] == k)[0]
        m = fit_gbm(Xtr[tr_idx], Ytr[tr_idx], args)
        oof[va_idx] = m.predict_proba(Xtr[va_idx])[:, 1]
    ts, tp, tl = pick(pools_of(tr, oof, Gtr), args.target)
    n, s, b, sil, pas = score_rule(pools_of(tr, oof, Gtr), ts, tp, tl)
    print(f"thresholds silent<{ts:.4f} pass>={tp} low<{tl}; out-of-fold: settled {s}/{n} ({s/n:.1%}), "
          f"disagree {b} ({b/max(1,s):.2%}), silent {sil}, pass {pas}")
    m = fit_gbm(Xtr, Ytr, args)
    pte = m.predict_proba(Xte)[:, 1]
    from sklearn.metrics import roc_auc_score

    auc = roc_auc_score(Yte, pte) if len(set(Yte)) > 1 else float("nan")
    n, s, b, sil, pas = score_rule(pools_of(te, pte, Gte), ts, tp, tl)
    print("HELD-OUT " + curve_line(pools_of(te, pte, Gte)))
    res = {"model": args.model, "curve": curve(pools_of(te, pte, Gte)), "heldout_calls": n, "settled": s, "settled_frac": s / max(1, n), "disagree": b,
           "disagree_frac": b / max(1, s), "silent": sil, "pass": pas, "item_auc": auc,
           "thresholds": [ts, tp, tl]}
    print(f"HELD-OUT {args.heldout}: settled {s}/{n} ({s/max(1,n):.1%}), disagree {b} ({b/max(1,s):.2%}), "
          f"silent {sil}, pass {pas}; item AUC {auc:.3f}")
    for pat in args.extra_eval:
        ex = load([pat], need_tags=not args.no_tags)
        Xe, Ye, Ge = matrix(ex)
        for d in drop:
            Xe[:, d] = 0
        n, s, b, sil, pas = score_rule(pools_of(ex, m.predict_proba(Xe)[:, 1], Ge), ts, tp, tl)
        print(f"EXTRA {pat}: settled {s}/{n} ({s/max(1,n):.1%}), disagree {b} ({b/max(1,s):.2%}), silent {sil}, pass {pas}")
        res[f"extra:{pat}"] = [n, s, b]
    imp = sorted(zip(m.feature_importances_, FEATURE_NAMES), reverse=True)[:12]
    print("importance:", ", ".join(f"{n}={v}" for v, n in imp))
    if args.json:
        json.dump(res, open(args.json, "w"))


if __name__ == "__main__":
    main()
