"""M10 data: exported items joined with Haiku card labels, family splits, and labels aligned to the reader's
candidates (lab only). Imported by the trainers and scorers in this directory.

Labels: REF files (`{h, c}` lines, last wins). Splits by family (D882's spirit for the sim): an item's family is its
skeleton (title and first own words with digits and capitalised words masked) or, for a planted item, its suite and
title skeleton; a family's hash puts it in held-out at `frac`. Planted items of train5 and train6 are always held out.
"""
import hashlib, json, re

KINDS = ["none", "freeze", "deadline", "limit", "absence", "prohibition", "dependency", "status-change", "preference", "already-done"]
ACTIONS = ["deploy", "delete-data", "pay", "share-external", "purchase", "travel", "book-food", "book-venue", "hire", "schedule", "contact", "send-gift", "attend", "sign"]


def load_jsonl(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def load_labels(*paths):
    out = {}
    for p in paths:
        for d in load_jsonl(p):
            if "c" in d:
                out[d["h"]] = d["c"] or {"kind": "none", "actions": [], "entities": [], "statement": ""}
    return out


def skeleton(row):
    t = re.sub(r"\b[A-Z][\w'’.-]*", "X", row["title"])
    t = re.sub(r"\d+", "9", t).lower()
    t = re.sub(r"^(re|fwd?|aw):\s*", "", t)
    w = re.sub(r"\b[A-Z][\w'’.-]*", "X", row["own"])
    w = re.sub(r"\d+", "9", w).lower()
    words = re.findall(r"[a-z]{4,}", w)[:12]
    return t + "|" + " ".join(words)


def family(row):
    return hashlib.sha256(skeleton(row).encode()).hexdigest()


def split_of(row, frac=0.2):
    # Generated families are train only: the held-out families stay the sim's.
    if row.get("suite") == "gen":
        return "train"
    if row.get("planted") and row.get("suite") in ("train5", "train6"):
        return "heldout"
    # The dev fold (model selection on the funnel): train3 and train4's planted items, never trained on.
    if row.get("planted") and row.get("suite") in ("train3", "train4"):
        return "dev"
    v = int(hashlib.sha256(("m10:" + family(row)).encode()).hexdigest()[:8], 16) / 2**32
    return "heldout" if v < frac else "train"


def norm(s):
    return re.findall(r"[a-z0-9]+", s.lower())


def align(row, card):
    """The card's fields as targets over the row's candidates: entity BIO tags over tokens, a role per date mention
    (0 none, 1 start, 2 end, 3 both), a flag per amount (the limit), and the statement's sentence."""
    toks = [t[0] for t in row["toks"]]
    low = [t.lower() for t in toks]
    n = len(toks)
    bio = [0] * n  # 0 O, 1 B, 2 I
    for e in card.get("entities", []) if card.get("kind", "none") != "none" else []:
        ew = norm(e)
        if not ew:
            continue
        k = len(ew)
        for i in range(n - k + 1):
            if [re.sub(r"[^a-z0-9]", "", x) for x in low[i : i + k]] == ew:
                if all(b == 0 for b in bio[i : i + k]):
                    bio[i] = 1
                    for j in range(i + 1, i + k):
                        bio[j] = 2
                break
    flagged = card.get("kind", "none") != "none"
    st, en = (card.get("start"), card.get("end")) if flagged else (None, None)
    roles = []
    for d in row["dates"]:
        r = (1 if d["day"] == st else 0) | (2 if d["day"] == en else 0)
        roles.append(r)
    lim = card.get("limit") if flagged else None
    amt = [1 if lim is not None and abs(a["value"] - lim) < 1e-6 else 0 for a in row["amounts"]]
    # Only the first mention of a limit value is its target.
    seen = False
    for i, v in enumerate(amt):
        if v and seen:
            amt[i] = 0
        seen = seen or bool(v)
    sw = set(norm(card.get("statement", "")))
    best, bs = -1, 0.0
    if flagged and sw:
        nsent = max([t[1] for t in row["toks"]], default=0) + 1
        for s in range(nsent):
            ws = set(norm(" ".join(t[0] for t in row["toks"] if t[1] == s)))
            if ws:
                j = len(ws & sw) / len(ws | sw)
                if j > bs:
                    best, bs = s, j
    return {"bio": bio, "roles": roles, "amt": amt, "stmt": best}
