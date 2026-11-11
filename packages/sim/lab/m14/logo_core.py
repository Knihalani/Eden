"""LOGO core (M14, D1021): the leave-one-generator-out screen's data, splits, metrics and text transforms.

Standard library only, so `bun run check` can test it without torch. The harness (`logo.py`) and the baseline model
(`hashnet.py`) build on it; another session's model plugs in through `logo.py`'s plugin interface or the `folds`
and `grade` commands.

A row is one task (`logo-export.ts`): {src, group, world, task, archetype, lang, requests, fact, decoy, neutrals,
others}, items as {source, title, text}. Labels come from construction: for a request, the fact `changes` what to do,
the decoy and neutrals are `clear` (relevant, all clear) and others are `unrelated`.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from dataclasses import dataclass, field

# ------------------------------------------------------------------------------------------------------------------
# Sources and splits.


def read_rows(path: str) -> list[dict]:
    with open(path, encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def group_split(group: str, test_share: float = 0.2) -> str:
    """A group's split from a hash of its name: every row of a template or family lands on one side."""
    h = int(hashlib.sha1(group.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "test" if h < test_share else "train"


@dataclass
class Source:
    name: str
    train: list[dict] = field(default_factory=list)
    test: list[dict] = field(default_factory=list)


def load_source(spec: str) -> Source:
    """`name=FILE` (split by group hash, 80/20) or `name=TRAIN:TEST` (the source's own split, e.g. M2's)."""
    name, _, paths = spec.partition("=")
    if not paths:
        raise ValueError(f"source spec {spec!r}: want name=FILE or name=TRAIN:TEST")
    s = Source(name)
    if ":" in paths:
        a, b = paths.split(":", 1)
        s.train, s.test = read_rows(a), read_rows(b)
    else:
        for r in read_rows(paths):
            (s.test if group_split(r["group"]) == "test" else s.train).append(r)
    for r in s.train + s.test:
        r["src"] = name
    return s


def cap_rows(rows: list[dict], n: int, seed: int) -> list[dict]:
    """At most n rows, drawn without replacement (a big source does not swamp a mixed training set)."""
    if n <= 0 or len(rows) <= n:
        return list(rows)
    return random.Random(seed).sample(rows, n)


# ------------------------------------------------------------------------------------------------------------------
# Metrics. A scorer gives item scores (P(fact) for an item alone) and pair scores (P(changes), P(relevant) for a
# request and an item); the screen reads three numbers per held-out source.


def auc(pos: list[float], neg: list[float]) -> float:
    """Mann-Whitney AUC, ties counted half."""
    if not pos or not neg:
        return float("nan")
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    ranks = [0.0] * len(allv)
    i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        for k in range(i, j + 1):
            ranks[k] = (i + j) / 2 + 1
        i = j + 1
    rpos = sum(r for r, (_, y) in zip(ranks, allv) if y == 1)
    return (rpos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def pair_win(a: list[float], b: list[float]) -> float:
    """Share of matched pairs where a beats b (ties half): fact against its own twin, task by task."""
    if not a:
        return float("nan")
    return sum(1.0 if x > y else 0.5 if x == y else 0.0 for x, y in zip(a, b)) / len(a)


def grade(rows: list[dict], item_scores: list[dict], pair_scores: list[list[dict]]) -> dict:
    """The screen's numbers for one held-out source.

    item_scores[i] = {"fact", "decoy", "neutrals": [...], "others": [...]} (P(fact) for the item alone);
    pair_scores[i][r] = the same shape for request r with each item, P(changes) under "c" and P(relevant) under "r":
    {"fact": (c, r), "decoy": (c, r), "neutrals": [(c, r)], "others": [(c, r)]}.

    - twin: fact beats its decoy, item alone (the D908/D909 measurement; 0.5 is chance);
    - twin_hard: the same on tasks whose decoy is at least as long as its fact (length cannot help);
    - twin_req: fact beats its decoy for the request (P(changes));
    - fact_at1: the fact ranks first by P(changes) among the task's own items and its others, per request;
    - relevance: AUC of P(relevant), the task's own items against others, per request pooled.
    """
    f = [s["fact"] for s in item_scores]
    d = [s["decoy"] for s in item_scores]
    # Length-controlled: tasks whose decoy is at least as long as the fact, where reading length alone scores at most
    # 0.5 (M2's facts are longer than their twins in 94% of tasks: a model can pass `twin` on length, D908).
    hard = [k for k, r in enumerate(rows) if len(item_text(r["decoy"])) >= len(item_text(r["fact"]))]
    tw_req_a, tw_req_b, at1, rel_pos, rel_neg = [], [], [], [], []
    for ps in pair_scores:
        for p in ps:
            tw_req_a.append(p["fact"][0])
            tw_req_b.append(p["decoy"][0])
            rest = [p["decoy"][0]] + [x[0] for x in p["neutrals"]] + [x[0] for x in p["others"]]
            at1.append(1.0 if p["fact"][0] > max(rest) else 0.0)
            rel_pos += [p["fact"][1], p["decoy"][1]] + [x[1] for x in p["neutrals"]]
            rel_neg += [x[1] for x in p["others"]]
    return {
        "tasks": len(rows),
        "requests": len(at1),
        "twin": round(pair_win(f, d), 4),
        "twin_hard": round(pair_win([f[k] for k in hard], [d[k] for k in hard]), 4),
        "hard_tasks": len(hard),
        "twin_auc_all_clear": round(auc(f, d + [x for s in item_scores for x in s["neutrals"]]), 4),
        "twin_req": round(pair_win(tw_req_a, tw_req_b), 4),
        "fact_at1": round(sum(at1) / max(1, len(at1)), 4),
        "relevance": round(auc(rel_pos, rel_neg), 4),
    }


def per_task(rows: list[dict], item_scores: list[dict], pair_scores: list[list[dict]]) -> dict:
    """Task-level outcomes for paired comparisons: the group (the bootstrap's cluster), the twin win (1, 0.5, 0),
    whether the task is length-controlled, and the share of its requests whose fact ranks first."""
    out = {"group": [], "twin": [], "hard": [], "at1": []}
    for r, it, ps in zip(rows, item_scores, pair_scores):
        out["group"].append(r["group"])
        out["twin"].append(1.0 if it["fact"] > it["decoy"] else 0.5 if it["fact"] == it["decoy"] else 0.0)
        out["hard"].append(len(item_text(r["decoy"])) >= len(item_text(r["fact"])))
        firsts = [1.0 if p["fact"][0] > max([p["decoy"][0]] + [x[0] for x in p["neutrals"] + p["others"]]) else 0.0
                  for p in ps]
        out["at1"].append(sum(firsts) / max(1, len(firsts)))
    return out


def cluster_diff(a: dict, b: dict, metric: str, n_boot: int = 2000, seed: int = 1) -> dict:
    """B minus A on the same test rows (per_task dicts, seeds averaged by the caller), with a 95% interval from a
    bootstrap over groups: tasks of one template or family move together (D488's lesson)."""
    hard_only = metric == "twin_hard"
    key = "twin" if hard_only else metric
    idx = [k for k in range(len(a[key])) if not hard_only or a["hard"][k]]
    groups: dict[str, list[int]] = {}
    for k in idx:
        groups.setdefault(a["group"][k], []).append(k)
    names = sorted(groups)
    diff = lambda ks: sum(b[key][k] - a[key][k] for k in ks) / max(1, len(ks))  # noqa: E731
    point = diff(idx)
    rng = random.Random(seed)
    boots = []
    for _ in range(n_boot):
        ks = [k for g in (rng.choice(names) for _ in names) for k in groups[g]]
        boots.append(diff(ks))
    boots.sort()
    return {"metric": metric, "tasks": len(idx), "groups": len(names), "a": round(sum(a[key][k] for k in idx) / max(1, len(idx)), 4),
            "b": round(sum(b[key][k] for k in idx) / max(1, len(idx)), 4), "diff": round(point, 4),
            "lo": round(boots[int(0.025 * n_boot)], 4), "hi": round(boots[int(0.975 * n_boot)], 4)}


# ------------------------------------------------------------------------------------------------------------------
# Text transforms (the recipes that need no model call).

_MONTHS = (
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?"
    "|nov(?:ember)?|dec(?:ember)?"
)
_WD = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?"
_NORM = [
    (re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"), " ⟨email⟩ "),
    (re.compile(r"\bhttps?://\S+|\bwww\.\S+|\b[\w-]+\.(?:example|com|org|net|co\.uk|io)(?:/\S*)?"), " ⟨url⟩ "),
    (re.compile(r"[£$€₹]\s?\d[\d,.]*(?:\s?[km]\b)?|\b\d[\d,.]*\s?(?:gbp|usd|eur|inr|aud|cad|nzd|chf|euros?|dollars?|pounds?)\b", re.I), " ⟨money⟩ "),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}(?:t\d{2}:?\d{2}(?::?\d{2})?z?)?\b|\b\d{8}t\d{6}z?\b", re.I), " ⟨date⟩ "),
    (re.compile(rf"\b(?:(?:{_WD}),?\s+)?\d{{1,2}}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:{_MONTHS})\.?(?:,?\s+\d{{4}})?\b", re.I), " ⟨date⟩ "),
    (re.compile(rf"\b(?:(?:{_WD}),?\s+)?(?:{_MONTHS})\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?\b", re.I), " ⟨date⟩ "),
    (re.compile(r"\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b"), " ⟨date⟩ "),
    (re.compile(r"\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d{1,2}[:.h]\d{2}\b", re.I), " ⟨time⟩ "),
    (re.compile(r"\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]+(?:[-/][a-z\d]+)+\b|\b[a-z]{1,4}-?\d{3,}\b", re.I), " ⟨ref⟩ "),
    (re.compile(r"\b\d+(?:[.,]\d+)?%"), " ⟨pct⟩ "),
    (re.compile(r"\b\d+(?:[.,]\d+)*\b"), " ⟨num⟩ "),
]
_CAP = re.compile(r"(?<=[a-z,;:] )[A-Z][a-z]+(?:\s[A-Z][a-z]+)*")


def normalise(text: str) -> str:
    """Typed placeholders for what changes between writers and worlds but not between a fact and its kind: emails,
    links, money, dates, times, reference codes, numbers, and capitalised names inside a sentence."""
    t = text
    for rx, rep in _NORM:
        t = rx.sub(rep, t)
    t = _CAP.sub("⟨name⟩", t)
    return re.sub(r"[ \t]+", " ", t)


_OCR = {"l": "1", "O": "0", "o": "0", "I": "l", "rn": "m", "m": "rn", "e": "c", "S": "5", "B": "8", "cl": "d"}


def noise(text: str, rng: random.Random, strength: float = 1.0) -> str:
    """Format and token noise, one random mix per call: dropped tokens, lost case and punctuation, hard line breaks
    and hyphenation (PDF extraction), OCR confusions, quoted-reply prefixes, chat timestamps."""
    words = text.split(" ")
    p = 0.12 * strength
    if rng.random() < 0.7:  # token dropout
        words = [w for w in words if rng.random() > p] or words
    t = " ".join(words)
    r = rng.random()
    if r < 0.2:
        t = t.lower()
    elif r < 0.3:
        t = re.sub(r"[.,;:!?'\"]", "", t)
    r = rng.random()
    if r < 0.2:  # PDF: hard breaks every 60-90 characters, a hyphen when a break splits a word
        out, line = [], ""
        width = rng.randint(60, 90)
        for w in t.split(" "):
            if len(line) + len(w) > width:
                if len(w) > 7 and rng.random() < 0.4:
                    cut = rng.randint(3, len(w) - 3)
                    out.append(f"{line} {w[:cut]}-".strip())
                    line = w[cut:]
                    continue
                out.append(line)
                line = w
            else:
                line = f"{line} {w}".strip()
        t = "\n".join(out + [line])
    elif r < 0.3:
        t = "\n".join("> " + x for x in t.split("\n"))
    elif r < 0.4:
        t = "\n".join(f"[{rng.randint(7, 22):02d}:{rng.randint(0, 59):02d}] {x}" for x in t.split("\n"))
    if rng.random() < 0.25:  # OCR confusions on a few characters
        chars = list(t)
        for _ in range(max(1, int(len(chars) * 0.02 * strength))):
            i = rng.randrange(len(chars)) if chars else 0
            if chars and chars[i] in _OCR:
                chars[i] = _OCR[chars[i]]
        t = "".join(chars)
    return t


def item_text(it: dict) -> str:
    return f"{it.get('title', '')}\n{it.get('text', '')}"


def length_balanced(rows: list[dict], seed: int) -> list[dict]:
    """Training rows resampled so the fact is the longer of fact and twin in half of them: the `lenbal` recipe."""
    longer = [r for r in rows if len(item_text(r["fact"])) > len(item_text(r["decoy"]))]
    rest = [r for r in rows if len(item_text(r["fact"])) <= len(item_text(r["decoy"]))]
    k = min(len(longer), len(rest))
    rng = random.Random(seed)
    return rng.sample(longer, k) + rng.sample(rest, k) if k else list(rows)
