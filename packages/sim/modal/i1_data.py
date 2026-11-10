"""I1's data checks and scoring (no Modal, no torch): pairs joined to the teacher's labels, training targets, AUCs.
Tested in tests/test_i1_data.py."""
import json
import re

TRAIN_SUITE = re.compile(r"^train\d$")


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def item_text(it):
    """What the checker reads of an item: its title and its cached text, as the push's pool holds them."""
    return f"{it['title']}\n{it['text']}"


def rows(groups, labels):
    """One row per labelled pair. Refuses any suite that is not train (held-out stays blind)."""
    by = {(lab["group"], lab["key"]): lab for lab in labels}
    out = []
    for g in groups:
        if not TRAIN_SUITE.match(g["suite"]):
            raise ValueError(f"i1: {g['suite']} is not a train suite")
        for it in g["items"]:
            lab = by.get((g["group"], it["key"]))
            if lab is None:
                continue
            out.append({"group": g["group"], "key": it["key"], "split": g["split"], "request": g["request"],
                        "item": item_text(it), "truth": it["truth"], "y": lab["y"] / 100.0})
    return out


def target_of(row, target):
    """The training target: the teacher's confidence (opus), the sim's truth (planted 1, else 0), or their mean."""
    truth = 1.0 if row["truth"] == "planted" else 0.0
    if target == "truth":
        return truth
    if target == "mix":
        return (row["y"] + truth) / 2
    return row["y"]


def auc(pos, neg):
    """Mann-Whitney AUC: the chance a positive outscores a negative (ties count half). None if a side is empty."""
    if not pos or not neg:
        return None
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    rank_sum, i = 0.0, 0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        mid = (i + j + 1) / 2  # 1-based mean rank of the tie block
        rank_sum += mid * sum(1 for k in range(i, j) if allv[k][1] == 1)
        i = j
    return (rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def report(rs, scores):
    """AUCs on a set of rows: against the teacher (y >= 0.5), planted against everything else, planted against decoys,
    and the teacher's own planted-vs-decoy separation for comparison."""
    pos_t = [s for r, s in zip(rs, scores) if r["y"] >= 0.5]
    neg_t = [s for r, s in zip(rs, scores) if r["y"] < 0.5]
    planted = [s for r, s in zip(rs, scores) if r["truth"] == "planted"]
    decoy = [s for r, s in zip(rs, scores) if r["truth"] == "decoy"]
    rest = [s for r, s in zip(rs, scores) if r["truth"] != "planted"]
    return {
        "n": len(rs),
        "auc_vs_teacher": auc(pos_t, neg_t),
        "auc_planted_vs_rest": auc(planted, rest),
        "auc_planted_vs_decoy": auc(planted, decoy),
        "teacher_planted_vs_decoy": auc([r["y"] for r in rs if r["truth"] == "planted"],
                                        [r["y"] for r in rs if r["truth"] == "decoy"]),
        "teacher_planted_vs_rest": auc([r["y"] for r in rs if r["truth"] == "planted"],
                                       [r["y"] for r in rs if r["truth"] != "planted"]),
    }
