"""Strict zero-overlap test for E1 cues: lex.ts tokenization (identifier split, stopwords) + a light suffix stemmer
+ a shared-prefix rule (>= 4 chars), so 'deploy'~'deployment', 'auth'~'authentication', 'merging'~'merge' all count as overlap."""
import re
from lexpy import toks


def lstem(w):
    for suf in ("ational", "ation", "ition", "ments", "ment", "ings", "ing", "ers", "er", "ies", "ied", "ed", "es", "ly", "s", "e"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: -len(suf)]
    return w


def atoms(s):
    return {t for t in toks(s) if re.fullmatch(r"[a-z0-9]+", t)}


def conflict(a, b):
    if a == b:
        return True
    sa, sb = lstem(a), lstem(b)
    if sa == sb:
        return True
    n = min(len(sa), len(sb))
    if n >= 4 and (sa.startswith(sb) or sb.startswith(sa)):
        return True
    return False


def shared(cue, row_text):
    ca, ra = atoms(cue), atoms(row_text)
    return sorted({f"{a}~{b}" if a != b else a for a in ca for b in ra if conflict(a, b)})


def row_text(m):
    return f"{m['subject']} {m['text']}"
