"""Load the sleep compiler's artifacts (COMPILE-SPEC.md) and build the hot-path matchers they imply.

Nothing here calls a model: the artifacts are files written offline; the matchers are dictionaries and regexes.
"""
import glob, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))


def load_compiled(fixture):
    base = os.path.join(HERE, "compiled", fixture)
    user = json.load(open(os.path.join(base, "user.json")))
    mem = {}
    for p in sorted(glob.glob(os.path.join(base, "mem-*.json"))):
        for r in json.load(open(p)):
            mem[r["id"]] = r
    return user, mem


def norm(s):
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9'@./+#\- ]+", " ", s)
    return " " + re.sub(r"\s+", " ", s).strip() + " "


class PhraseMatcher:
    """Whole-word phrase lookup: phrase -> labels. Matches a phrase and its possessive / plural ('sam's', 'trips')."""

    def __init__(self, table):
        self.table = {}
        for label, phrases in table.items():
            for p in phrases:
                p = norm(p).strip()
                if len(p) < 2:
                    continue
                self.table.setdefault(p, set()).add(label)
        self.maxlen = max((len(p.split()) for p in self.table), default=1)

    def find(self, text):
        words = norm(text).split()
        hits = {}
        for n in range(1, self.maxlen + 1):
            for i in range(len(words) - n + 1):
                ph = " ".join(words[i:i + n])
                for cand in (ph, re.sub(r"'s$", "", ph), re.sub(r"s$", "", ph)):
                    if cand in self.table:
                        for lab in self.table[cand]:
                            hits[lab] = max(hits.get(lab, 0), n)
                        break
        return hits
