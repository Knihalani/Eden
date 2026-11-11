"""M8 router harness (D940-D949; docs/research/m8-router.md): offline examples, online per-user replay, metrics.

Reads worlds exported by `packages/sim/src/lab/m8-export.ts` (term hashes from Eden's own tokenizer). A user's
requests are replayed in time order; each request sees the user's sources (with `noise` synthetic connectors added)
and the items held before it, never its own task's items (the needed item has not been seen: the case where a live
read matters). After a task, the router is told the fact's source was used (the `sourceYield` signal).

A router is an object with:
  fit(worlds)                      global training on train worlds (may be a no-op)
  user(world_view) -> state        per-user state (online heads), built empty
  score(state, req, view) -> np.ndarray of one logit (or log-probability) per source in view.sources
  used(state, view, src_index)     the feedback after a task
Numpy only, so a CPU helper can run it.
"""
from __future__ import annotations

import json
import math
import random
import sys
import time
from dataclasses import dataclass, field

import numpy as np

M32 = 0xFFFFFFFF
DIM = 1 << 18  # feature buckets


def mix32(h: int) -> int:
    """murmur3 fmix32, as `mix32` in @eden/primitives."""
    h &= M32
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & M32
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & M32
    h ^= h >> 16
    return h


def fnv(s: str) -> int:
    h = 0x811C9DC5
    for ch in s:
        h = ((h ^ ord(ch)) * 0x01000193) & M32
    return h


def bigram(a: int, b: int) -> int:
    return mix32((a * 0x9E3779B1 + b) & M32)


def feats(h: list[int], bigrams: bool = True) -> np.ndarray:
    """Bucket ids of a term sequence: unigrams, and bigrams of neighbours."""
    out = [mix32(x) % DIM for x in h]
    if bigrams:
        out += [bigram(h[i], h[i + 1]) % DIM for i in range(len(h) - 1)]
    return np.asarray(out, dtype=np.int64)


# ---------------------------------------------------------------------------------------------------------------
# Noise connectors: like the lab's (`noise-sources.ts`): a work vocabulary and words of their own.

NOISE_KINDS = ["jira", "wiki", "slack-channel", "dashboard", "drive-folder", "github", "zendesk", "figma", "sheets"]
NOISE_DESC = {
    "jira": "Issue tracker tickets and sprints (Jira)",
    "wiki": "Team wiki pages (Confluence)",
    "slack-channel": "A shared chat channel (Slack)",
    "dashboard": "Metrics dashboards and alerts",
    "drive-folder": "A shared team folder of files",
    "github": "Code repositories, pull requests and issues (GitHub)",
    "zendesk": "Customer support tickets (Zendesk)",
    "figma": "Design files and comments (Figma)",
    "sheets": "Shared spreadsheets",
}
WORK = (
    "sprint backlog deploy metric dashboard widget pipeline schema endpoint latency cluster shard label channel "
    "standup retro epic story bug triage design mockup component release branch merge build artifact queue alert "
    "migration rollout flag experiment cohort funnel retention churn quota region replica index cache token webhook"
).split()
SYL = "ba co di fu ga he ji ko lu ma ne pi qua ro su ti vu wa xe yo zu bra cle dri flo".split()


def noise_sources(seed: int, n: int, t0: int, people: list[int]) -> tuple[list[dict], list[dict]]:
    """`n` noise connectors, 12 items each spread over the 60 days before `t0` (term hashes, a name now and then)."""
    r = random.Random(seed)
    srcs, items = [], []
    for k in range(n):
        kind = NOISE_KINDS[k % len(NOISE_KINDS)]
        sid = f"{kind}-{k}"
        desc = [fnv(w) for w in f"{kind} {NOISE_DESC[kind]}".lower().replace("(", " ").replace(")", " ").split()]
        srcs.append({"id": sid, "d": desc, "noise": True})
        own = ["".join(r.choice(SYL) for _ in range(r.randint(2, 4))) for _ in range(40)]
        for _ in range(12):
            words = [r.choice(WORK) if r.random() < 0.5 else r.choice(own) for _ in range(r.randint(20, 80))]
            h = [fnv(w) for w in words]
            names = []
            if people and r.random() < 0.03:
                names = [r.choice(people)]
                h.append(names[0])
            items.append({"s": sid, "at": t0 - r.randint(1, 60) * 86_400_000, "h": h, "n": names})
    return srcs, items


# ---------------------------------------------------------------------------------------------------------------


@dataclass
class View:
    """One user as the router sees them: sources, every item (with `held` masks per request) and per-source ids."""

    wid: str
    sources: list[dict]
    items: list[dict]
    src_index: dict[str, int]
    item_src: np.ndarray  # source index per item
    item_at: np.ndarray
    rare: set = field(default_factory=set)


@dataclass
class Example:
    view: View
    req: dict
    held: np.ndarray  # item indexes held before the request (own task excluded)
    label: int  # source index of the needed item
    rare: bool
    task: dict


COMMON = {"gmail", "calendar", "drive", "slack", "crm"}


def load(path: str, limit: int | None = None) -> list[dict]:
    out = []
    with open(path) as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
                if limit and len(out) >= limit:
                    break
    return out


def view_of(w: dict, noise: int, seed: int = 0) -> View:
    sources = [dict(s) for s in w["sources"]]
    items = list(w["items"])
    if noise:
        t0 = max((it["at"] for it in items), default=0)
        people = sorted({n for it in items for n in it.get("n", [])})
        ns, ni = noise_sources(hash((w["id"], seed)) & M32, noise, t0, people)
        sources += ns
        items += ni
    # Source order carries nothing (noise connectors are not all last).
    random.Random(hash((w["id"], seed, "order")) & M32).shuffle(sources)
    src_index = {s["id"]: k for k, s in enumerate(sources)}
    return View(
        wid=w["id"],
        sources=sources,
        items=items,
        src_index=src_index,
        item_src=np.asarray([src_index[it["s"]] for it in items], dtype=np.int64),
        item_at=np.asarray([it["at"] for it in items], dtype=np.int64),
    )


EXCLUDE = "fact"  # "fact": only the needed item is unseen; "task": its task's look-alike and neutrals too


def replay(w: dict, noise: int, seed: int = 0):
    """Yields ("req", Example) in time order and ("used", view, src) after each task."""
    v = view_of(w, noise, seed)
    tasks = sorted(w["tasks"], key=lambda t: min(r["at"] for r in t["reqs"]))
    for t in tasks:
        if t["src"] not in v.src_index:
            continue
        own = set(t["own"]) if EXCLUDE == "task" else {t["fact"]}
        label = v.src_index[t["src"]]
        for r in t["reqs"]:
            held = np.asarray(
                [k for k in range(len(v.items)) if v.items[k]["at"] <= r["at"] and k not in own], dtype=np.int64
            )
            yield "req", Example(v, r, held, label, t["src"] not in COMMON, t)
        yield "used", v, label


# ---------------------------------------------------------------------------------------------------------------
# Metrics


def to_probs(s: np.ndarray) -> np.ndarray:
    z = s - s.max()
    p = np.exp(z)
    return p / p.sum()


def evaluate(router, worlds: list[dict], noise: int, seed: int = 0, keep: bool = False):
    """Rows of (probabilities, label, rare, n_sources, n_real) per request, after the online replay."""
    rows = []
    t0 = time.perf_counter()
    n = 0
    for w in worlds:
        st = None
        for kind, *rest in replay(w, noise, seed):
            if kind == "used":
                view, src = rest
                if st is not None:
                    router.used(st, view, src)
                continue
            ex = rest[0]
            if st is None:
                st = router.user(ex.view)
            s = np.asarray(router.score(st, ex.req, ex.view, ex.held), dtype=np.float64)
            n += 1
            real = sum(1 for x in ex.view.sources if not x.get("noise"))
            rows.append((s, ex.label, ex.rare, len(ex.view.sources), real, ex.task["timing"]))
    ms = 1000 * (time.perf_counter() - t0) / max(1, n)
    return rows, ms


def fit_temperature(rows) -> float:
    """The temperature that minimises the validation rows' log loss (scores to calibrated probabilities)."""
    best, bt = float("inf"), 1.0
    for t in np.exp(np.linspace(math.log(0.02), math.log(50), 60)):
        nll = 0.0
        for s, y, *_ in rows:
            z = s / t
            z = z - z.max()
            nll -= z[y] - math.log(np.exp(z).sum())
        if nll < best:
            best, bt = nll, t
    return bt


def calibrated(rows, t: float):
    return [(to_probs(r[0] / t),) + tuple(r[1:]) for r in rows]


def rank_of(s: np.ndarray, y: int) -> float:
    """The label's rank with ties broken at random in expectation (a tie is not a win)."""
    return float((s > s[y]).sum() + 0.5 * ((s == s[y]).sum() - 1))


def set_sizes(rows, q: float):
    """Per request: the smallest top set whose probability mass reaches q; whether it holds the label."""
    hit, size = [], []
    jit = np.random.default_rng(5)
    for p, y, *_ in rows:
        order = np.lexsort((jit.random(len(p)), -p))
        c = np.cumsum(p[order])
        k = int(np.searchsorted(c, q) + 1)
        k = min(k, len(p))
        top = order[:k]
        hit.append(y in set(top.tolist()))
        size.append(k)
    return np.asarray(hit), np.asarray(size)


def q_for_recall(rows, target: float) -> float:
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = (lo + hi) / 2
        hit, _ = set_sizes(rows, mid)
        if hit.mean() >= target:
            hi = mid
        else:
            lo = mid
    return hi


def report(name: str, val_rows, test_rows, ms: float, target: float = 0.98) -> dict:
    temp = fit_temperature(val_rows)
    raw_test = test_rows
    val_rows, test_rows = calibrated(val_rows, temp), calibrated(test_rows, temp)
    q = q_for_recall(val_rows, target)
    hit, size = set_sizes(test_rows, q)
    rare = np.asarray([r[2] for r in test_rows])
    nsrc = np.asarray([r[3] for r in test_rows])
    nreal = np.asarray([r[4] for r in test_rows])
    ranks = []
    for s_, y, *_ in raw_test:
        ranks.append(rank_of(np.asarray(s_), y))
    ranks = np.asarray(ranks)
    out = {
        "router": name,
        "test_requests": len(test_rows),
        "top1": float((ranks == 0).mean()),
        "top3": float((ranks < 3).mean()),
        "mrr": float((1 / (ranks + 1)).mean()),
        "temperature": round(float(temp), 4),
        "q_val": round(q, 5),
        "recall_at_q": float(hit.mean()),
        "recall_rare_at_q": float(hit[rare].mean()) if rare.any() else None,
        "recall_common_at_q": float(hit[~rare].mean()) if (~rare).any() else None,
        "calls_at_q": float(size.mean()),
        "share_of_real_sources": float((size / nreal).mean()),
        "share_of_all_sources": float((size / nsrc).mean()),
        "mean_real_sources": float(nreal.mean()),
        "mean_all_sources": float(nsrc.mean()),
        "ms_per_request_py": round(ms, 3),
    }
    for k in (1, 2, 3, 4, 5):
        out[f"recall@{k}"] = float((ranks < k).mean())
        out[f"rare_recall@{k}"] = float((ranks[rare] < k).mean()) if rare.any() else None
    return out


def main_eval(router, name: str, data_dir: str, noise: int = 20, val_limit=None, test_limit=None, out=None):
    val = load(f"{data_dir}/x-val.jsonl", val_limit)
    test = load(f"{data_dir}/x-test.jsonl", test_limit)
    vr, _ = evaluate(router, val, noise, 1)
    tr, ms = evaluate(router, test, noise, 2)
    rep = report(name, vr, tr, ms)
    rep["noise"] = noise
    line = json.dumps(rep)
    print(line, flush=True)
    if out:
        with open(out, "a") as f:
            f.write(line + "\n")
    return rep


if __name__ == "__main__":
    print("import this module; see routers.py", file=sys.stderr)
