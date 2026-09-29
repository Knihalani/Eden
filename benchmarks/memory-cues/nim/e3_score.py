"""E3 scoring: per-field precision / recall of extractions vs the hand annotation (e3_data.py)."""
import collections, re
from e3_regex import norm_value

DURABLE_CATS = {"slot", "policy", "intent", "mixed"}
PLAIN_CATS = {"request", "trap", "status", "paste"}


def parse_gold(anns):
    out = []
    for a in anns:
        parts = a.split()
        if parts[0] == "slot":
            alts = []
            for alt in parts[1].split("|") if "=" in parts[1].split("|")[-1] else [parts[1]]:
                if "!=" in alt:
                    s, v = alt.split("!="); alts.append((s, "invalidate", norm_value(v)))
                else:
                    s, v = alt.split("="); alts.append((s, "set", norm_value(v)))
            # support "slot a=b c" (multi-word values)
            if len(parts) > 2:
                s, op, v = alts[0]; alts = [(s, op, norm_value(v + " " + " ".join(parts[2:])))]
            out.append(dict(kind="slot", alts=alts))
        else:
            kind, cls, pol, obj = parts[0], parts[1].split("|"), parts[2], parts[3].split("|")
            q = next((p[2:] for p in parts[4:] if p.startswith("q=")), None)
            out.append(dict(kind=kind, cls=cls, pol=pol, obj=obj, qual=q))
    return out


def norm_pred(p):
    if p.get("kind") == "slot":
        return dict(kind="slot", slot=str(p.get("slot", "")).strip().lower(), op=("invalidate" if str(p.get("op", "set")).lower().startswith(("inv", "ret", "unset", "remove")) else "set"),
                    value=norm_value(str(p.get("value", ""))))
    if p.get("kind") in ("policy", "intent"):
        q = p.get("qual") or p.get("qualifier")
        q = None if q in (None, "", "none", "null") else str(q).lower().replace(" ", "-").replace("_", "-")
        return dict(kind=p["kind"], cls=str(p.get("cls") or p.get("class") or "").lower().replace("_", "-"), pol=str(p.get("pol") or p.get("polarity") or "").lower()[:3],
                    obj=str(p.get("obj") or p.get("object") or "*").lower().strip() or "*", qual=q)
    return None


def obj_ok(pred_obj, gold_objs):
    po = pred_obj.lower().strip()
    for g in gold_objs:
        if g == "*" and po in ("*", "", "none", "any"):
            return True
        if g != "*" and (po == g or re.sub(r"s$", "", po) == g or g in po.split() or po.startswith(g)):
            return True
    return False


# class-default objects: an implicit object a model may fill in ("merge" -> pr, "force-push" -> branch) normalizes to "*"
CLASS_DEFAULT = {"integrate": {"pr", "prs", "pull request", "branch", "changes", "code"}, "review": {"pr", "prs", "pull request", "pull requests"},
                 "history-rewrite": {"branch", "commits", "commit", "history"}, "dependency": {"dependency", "dependencies", "package", "packages", "deps", "dep"},
                 "deploy": {"prod", "production"}, "push-upstream": {"branch", "remote", "origin", "changes", "commits"}, "commit": {"changes", "code"},
                 "billing": {"billing", "billing code"}, "delete": {"files", "file"}, "branch": {"branch", "feature branch"}, "stash": {"changes"}}


def obj_ok_lenient(cls, pred_obj, gold_objs):
    po = pred_obj.lower().strip()
    if po in CLASS_DEFAULT.get(cls, set()):
        po = "*"
    gl = ["*" if g in CLASS_DEFAULT.get(cls, set()) else g for g in gold_objs]
    return obj_ok(po, gl) or obj_ok(pred_obj, gold_objs)


def score(items, preds):
    """items: list of (text, cat, anns); preds: list of list of raw extraction dicts (same order)."""
    c = collections.Counter(); per_cat = collections.defaultdict(collections.Counter); errs = []
    for (text, cat, anns), raw in zip(items, preds):
        gold = parse_gold(anns); pr = [x for x in (norm_pred(p) for p in (raw or [])) if x]
        gs = [g for g in gold if g["kind"] == "slot"]; gr = [g for g in gold if g["kind"] != "slot"]
        ps = [p for p in pr if p["kind"] == "slot"]; prr = [p for p in pr if p["kind"] != "slot"]
        per_cat[cat]["n"] += 1; per_cat[cat]["any_pred"] += bool(pr); per_cat[cat]["any_gold"] += bool(gold)
        c["items"] += 1
        c["det_tp"] += bool(pr) and bool(gold); c["det_fp"] += bool(pr) and not bool(gold); c["det_fn"] += (not pr) and bool(gold)
        if cat in PLAIN_CATS:
            c["plain_n"] += 1; c["plain_false_durable"] += bool(pr)
            c["plain_false_slot"] += bool(ps); c["plain_false_rule"] += bool(prr)
        # --- slots: exact (slot, op, value); and slot key only
        used = set()
        for p in ps:
            hit = next((i for i, g in enumerate(gs) if i not in used and any(p["slot"] == s and p["op"] == op and p["value"] == v for s, op, v in g["alts"])), None)
            if hit is not None:
                used.add(hit); c["slot_tp"] += 1
            else:
                c["slot_fp"] += 1; errs.append(("slot_fp", text, p))
        c["slot_fn"] += len(gs) - len(used)
        for i, g in enumerate(gs):
            if i not in used:
                errs.append(("slot_fn", text, g["alts"]))
        used_k = set()
        for p in ps:
            hit = next((i for i, g in enumerate(gs) if i not in used_k and any(p["slot"] == s and p["op"] == op for s, op, _ in g["alts"])), None)
            if hit is not None:
                used_k.add(hit); c["slotkey_tp"] += 1
            else:
                c["slotkey_fp"] += 1
        c["slotkey_fn"] += len(gs) - len(used_k)
        # --- rules: match on (class, polarity); then kind / object / qualifier accuracy on matched pairs
        used = set()
        for p in prr:
            hit = next((i for i, g in enumerate(gr) if i not in used and p["cls"] in g["cls"] and p["pol"] == g["pol"]), None)
            if hit is None:
                c["rule_fp"] += 1; errs.append(("rule_fp", text, p)); continue
            used.add(hit); g = gr[hit]; c["rule_tp"] += 1
            c["kind_ok"] += p["kind"] == g["kind"]
            c["obj_ok"] += obj_ok(p["obj"], g["obj"])
            c["obj_len_ok"] += obj_ok_lenient(p["cls"], p["obj"], g["obj"])
            c["rule_len_tp"] += p["kind"] == g["kind"] and obj_ok_lenient(p["cls"], p["obj"], g["obj"])
            strict = p["kind"] == g["kind"] and obj_ok(p["obj"], g["obj"])
            c["rule_strict_tp"] += strict
            if not strict:
                errs.append(("rule_partial", text, (p, g)))
            if g["kind"] == "intent":
                c["intent_matched"] += 1; c["qual_ok"] += (p.get("qual") == g["qual"])
        c["rule_fn"] += len(gr) - len(used)
        c["intent_gold"] += sum(g["kind"] == "intent" for g in gr); c["policy_gold"] += sum(g["kind"] == "policy" for g in gr)
        for i, g in enumerate(gr):
            if i not in used:
                errs.append(("rule_fn", text, g))
    P = lambda tp, fp: tp / (tp + fp) if tp + fp else float("nan")
    R = lambda tp, fn: tp / (tp + fn) if tp + fn else float("nan")
    m = dict(
        detect_P=P(c["det_tp"], c["det_fp"]), detect_R=R(c["det_tp"], c["det_fn"]),
        plain_false_durable=c["plain_false_durable"] / c["plain_n"], plain_false_n=c["plain_false_durable"], plain_n=c["plain_n"],
        slot_P=P(c["slot_tp"], c["slot_fp"]), slot_R=R(c["slot_tp"], c["slot_fn"]),
        slotkey_P=P(c["slotkey_tp"], c["slotkey_fp"]), slotkey_R=R(c["slotkey_tp"], c["slotkey_fn"]),
        rule_P=P(c["rule_tp"], c["rule_fp"]), rule_R=R(c["rule_tp"], c["rule_fn"]),
        rule_strict_P=P(c["rule_strict_tp"], c["rule_fp"] + c["rule_tp"] - c["rule_strict_tp"]), rule_strict_R=R(c["rule_strict_tp"], c["rule_fn"] + c["rule_tp"] - c["rule_strict_tp"]),
        rule_len_P=P(c["rule_len_tp"], c["rule_fp"] + c["rule_tp"] - c["rule_len_tp"]), rule_len_R=R(c["rule_len_tp"], c["rule_fn"] + c["rule_tp"] - c["rule_len_tp"]),
        obj_len_acc=c["obj_len_ok"] / c["rule_tp"] if c["rule_tp"] else float("nan"),
        kind_acc=c["kind_ok"] / c["rule_tp"] if c["rule_tp"] else float("nan"), obj_acc=c["obj_ok"] / c["rule_tp"] if c["rule_tp"] else float("nan"),
        qual_acc=c["qual_ok"] / c["intent_matched"] if c["intent_matched"] else float("nan"),
        counts=dict(c), per_cat={k: dict(v) for k, v in per_cat.items()})
    return m, errs
