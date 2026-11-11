"""M13 gate features: hashed character and word n-grams of one user turn, with no tokenizer and no pretrained table.
The TypeScript twin (packages/engine/src/gate-model.ts) must give the same ids for the same text: change both.

norm: NFKC, lower case, ASCII digits to 0, runs of white space to one space, the first 300 code points.
Hash: FNV-1a 32 over code points, seeded by a salt code point; bucket = hash & (B - 1).
Groups (the `groups` string): c char 1-4-grams of the whole (BOS 2, EOS 3); h char 2-4-grams of the first 20 code
points; e char 1-3-grams of the last 10; w words (letters/digits/apostrophe runs) and word bigrams; p the first three
words and the last one, salted by position, and the word count.
"""
import re
import unicodedata

FNV0, FNVP, M32 = 2166136261, 16777619, 0xFFFFFFFF
MAXCP = 300
_ws = re.compile(r"[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
_dig = re.compile(r"[0-9]")


def norm(s):
    s = unicodedata.normalize("NFKC", s[:4 * MAXCP]).lower()
    s = _ws.sub(" ", _dig.sub("0", s)).strip(" ")
    return s[:MAXCP]


def h(salt, cps):
    x = (FNV0 ^ salt) * FNVP & M32
    for c in cps:
        x = ((x ^ c) * FNVP) & M32
    return x


def is_word(ch):
    """A letter, a mark (Devanagari vowel signs) or a number (Unicode categories L, M, N), or an apostrophe."""
    return unicodedata.category(ch)[0] in "LMN" or ch in "'’"


def words(t):
    out, cur = [], []
    for ch in t:
        if is_word(ch):
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def fin(x, k):
    """A gram's id from its running FNV state and its length (so 1- to 4-grams from one start share one pass)."""
    return ((x ^ (k + 0x5BD1)) * FNVP) & M32


def grams(cps, lo, hi, salt, out, mask):
    n = len(cps)
    seed = ((FNV0 ^ salt) * FNVP) & M32
    for i in range(n):
        x = seed
        for k in range(1, min(hi, n - i) + 1):
            x = ((x ^ cps[i + k - 1]) * FNVP) & M32
            if k >= lo:
                out.add(fin(x, k) & mask)


def featurise(text, groups="chewp", bits=16):
    mask = (1 << bits) - 1
    t = norm(text)
    cps = [ord(c) for c in t]
    out = set()
    if "c" in groups:
        grams([2] + cps + [3], 1, 4, 100, out, mask)
    if "h" in groups:
        grams(([2] + cps)[:20], 2, 4, 200, out, mask)
    if "e" in groups:
        grams((cps + [3])[-10:], 1, 3, 300, out, mask)
    ws = words(t) if ("w" in groups or "p" in groups) else []
    if "w" in groups:
        wc = [[ord(c) for c in w] for w in ws]
        for w in wc:
            out.add(h(400, w) & mask)
        for a, b in zip(wc, wc[1:]):
            out.add(h(401, a + [32] + b) & mask)
    if "p" in groups:
        for i, w in enumerate(ws[:3]):
            out.add(h(500 + i, [ord(c) for c in w]) & mask)
        if ws:
            out.add(h(510, [ord(c) for c in ws[-1]]) & mask)
        out.add(h(520, [min(len(ws), 20)]) & mask)
    return sorted(out)


def skeleton_vocab(texts, k):
    """H8: the K commonest words of the training turns (any language), kept as themselves in the skeleton."""
    from collections import Counter
    c = Counter(w for t in texts for w in set(words(norm(t))))
    return sorted(w for w, _ in c.most_common(k))


def shape(w):
    return "0" if "0" in w else "x"


def skeleton_feats(text, vocab, bits=16):
    """Word 1-3-grams of the turn with every word outside `vocab` replaced by its shape, from the turn's start."""
    mask = (1 << bits) - 1
    vs = set(vocab) if not isinstance(vocab, set) else vocab
    sk = [w if w in vs else shape(w) for w in words(norm(text))][:40]
    out = set()
    seq = [[2]] + [[ord(c) for c in w] for w in sk] + [[3]]
    for n in (1, 2, 3):
        for i in range(len(seq) - n + 1):
            cps = []
            for w in seq[i:i + n]:
                cps += w + [32]
            out.add(h(700 + n + (10 if i == 0 else 0), cps) & mask)
    return sorted(out)
