"""Token helpers shared by assemble.py and score.py: content tokens of an item or an event, and coverage."""
import re

STOP = set("""a an the and or but if then else of to in on at by for with from into onto over under about as is are was
were be been being it its this that these those there here we you your our they them their he she him her his hers
i me my mine do does did done not no yes so too very can could should would will shall may might must have has had
just also only than such any all some each every both either neither one ones what which who whom whose when where
why how up down out off again further once more most other same own s t don now get got use used using uses make
made let lets via per please thanks thank ok okay like need needs want wants know see go going""".split())

_TOK = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/@+#:-]*[A-Za-z0-9]|[A-Za-z0-9]")


def raw_tokens(text):
    return [t.lower() for t in _TOK.findall(text or "")]


def tokens(text):
    """Lower-cased tokens plus the parts of compound tokens (`.nvmrc` → `nvmrc`, `apps/web` → `apps`, `web`)."""
    out = set()
    for t in raw_tokens(text):
        out.add(t)
        for p in re.split(r"[._/@+#:-]", t):
            if p:
                out.add(p)
    return out


def stem(t):
    for suf in ("ing", "ed", "es", "s"):
        if len(t) > len(suf) + 3 and t.endswith(suf):
            return t[: -len(suf)]
    return t


def content(text):
    """Content tokens: not stop words, 3+ characters or containing a digit; stemmed lightly."""
    out = set()
    for t in raw_tokens(text):
        if t in STOP:
            continue
        if len(t) >= 3 or any(c.isdigit() for c in t):
            out.add(stem(t))
    return out


def stems(text):
    return {stem(t) for t in tokens(text)}


def coverage(item_text, text, exclude=()):
    """Share of the item's content tokens (minus `exclude`) found in `text`."""
    need = content(item_text) - set(exclude)
    if not need:
        return 0.0
    have = stems(text)
    return sum(1 for t in need if t in have) / len(need)
