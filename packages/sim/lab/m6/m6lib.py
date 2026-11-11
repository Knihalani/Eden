"""M6 (D920-D921): shared pieces for the trimmer's trainers and screen. Pure Python + numpy; no pretrained weights.

The unit is a *part* (a sentence or line as `messageParts` splits it, render.ts). A trimmer gives each part of a
delivered item a keep score; `render_line` rebuilds the item's packet line from the kept parts the way render.ts
does (title, then the kept parts in order, gaps marked " … ", at most 320 bytes).
"""

import json
import re
import zlib

# engine/src/text.ts STOPWORDS
STOP = set(
    (
        "a an and are as at be been but by can could did do does for from had has have he her him his how i if in into "
        "is it its just me my no not of on or our please she so some than that the their them then there these they "
        "this to up us was we were what when where which who why will with would you your yes ok okay thanks thank hi "
        "hello hey sure great cool also about after again all am any because before being both each few get got here "
        "more most much need only other out over own same should still such too under until very want way well while"
    ).split(" ")
)
WORD = re.compile(r"[^\W_]+", re.UNICODE)  # letters and digits, as render.ts's WORDS
DIGIT = re.compile(r"\d")
ITEM_BYTES = 320


def toks(text):
    return WORD.findall(text.lower())


def focus_of(request):
    return {w for w in toks(request) if len(w) > 1 and w not in STOP}


def key_ok(row, text):
    """Every labelled key token of the planted item is among the tokens of its line (title included)."""
    have = set(toks(row["title"] + " " + text))
    return all(w in have for w in row["words"])


def joined(parts, keep):
    out, last = "", -1
    for k, p in enumerate(parts):
        if not keep[k]:
            continue
        out += ((" " if k == last + 1 else " … ") + p) if out else p
        last = k
    return out


def cap(text, n=ITEM_BYTES):
    b = text.encode()
    if len(b) <= n:
        return text
    return b[: n - 3].decode("utf8", "ignore") + "…"


def line_of(row, text):
    title = row["title"]
    if not text:
        return f"- [{row['src']}] {title}"
    return f"- [{row['src']}] {title}: {text}" if title else f"- [{row['src']}] {text}"


def trimmed_text(row, keep):
    return cap(joined([p[0] for p in row["parts"]], keep))


def pick(row, budget):
    """render.ts's `pick` at `budget` bytes (B0 at 320, B1 below)."""
    parts = row["parts"]
    focus = focus_of(row["request"])

    def score(k, p):
        text, flags = p
        n = 0.5 if k == 0 else 0.0
        for w in toks(text):
            if w in focus:
                n += 1
        n += 1 if DIGIT.search(text) else 0
        if flags & 1:
            return n - 0.75 if n >= 1 else -1
        return n - k * 0.001

    ranked = [(k, score(k, p), len(p[0].encode()) + 3) for k, p in enumerate(parts)]
    whole = [p[0] for k, p in enumerate(parts) if not (p[1] & 1) or ranked[k][1] > 0]
    if len(" ".join(whole).encode()) <= budget:
        return " ".join(whole)
    keep, room = set(), budget
    for k, s, b in sorted([r for r in ranked if r[1] > -1], key=lambda r: -r[1]):
        if b > room:
            continue
        keep.add(k)
        room -= b
    if not keep:
        return cap(" ".join(whole), budget)
    return joined([p[0] for p in parts], [k in keep for k in range(len(parts))])


def load(path, sets=None):
    rows = []
    for line in open(path):
        r = json.loads(line)
        if sets is None or r["set"] in sets:
            rows.append(r)
    return rows


def h(s, buckets):
    return zlib.crc32(s.encode()) % buckets


def grams(text, buckets, prefix=""):
    """Hashed words, word bigrams and char 3/4-grams inside words (M3's binnet `grams`)."""
    ws = toks(text)[:120]
    out = set()
    for w in ws:
        out.add(h(prefix + "w" + w, buckets))
        p = f"<{w}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                out.add(h(prefix + "c" + p[k : k + n], buckets))
    for a, b in zip(ws, ws[1:]):
        out.add(h(prefix + "b" + a + " " + b, buckets))
    return sorted(out)


def screen(rows, keep_fn, name=""):
    """The pre-registered offline screen for one set: fact keep, look-alike keep, item-line bytes against shipped.

    keep_fn(row) -> list of bools (one a part) or a text (an already trimmed line body)."""
    st = {"fact": [0, 0, 0], "decoy": [0, 0, 0]}  # labelled, shipped ok, trimmed ok given shipped ok
    b_ship = b_trim = 0
    for r in rows:
        k = keep_fn(r)
        text = k if isinstance(k, str) else trimmed_text(r, k)
        b_ship += len(line_of(r, r["shipped"]).encode())
        b_trim += len(line_of(r, text).encode())
        if r["role"] in st and r["words"]:
            s = st[r["role"]]
            s[0] += 1
            if key_ok(r, r["shipped"]):
                s[1] += 1
                if key_ok(r, text):
                    s[2] += 1
    f, d = st["fact"], st["decoy"]
    return {
        "name": name,
        "fact_keep": f[2] / max(f[1], 1),
        "facts": f"{f[2]}/{f[1]}",
        "decoy_keep": d[2] / max(d[1], 1),
        "decoys": f"{d[2]}/{d[1]}",
        "bytes": b_trim / max(b_ship, 1),
        "rows": len(rows),
    }


def fmt(m):
    return (
        f"{m['name']:<28} fact {m['fact_keep']*100:5.1f}% ({m['facts']})  decoy {m['decoy_keep']*100:5.1f}% "
        f"({m['decoys']})  bytes {m['bytes']*100:5.1f}%  rows {m['rows']}"
    )
