"""History evidence for the downstream judge (C4-E8 finding).

The judge's `reference_facts` are the planned items only. Real memory also holds episodic state from earlier sessions
(an unpushed commit, a queue-name bug, a branch), so a response that recalls it was marked as fabricating. This
gives the judge the earlier stream events that support or refute the specific tokens a response adds: tokens in
any response but not in the turn or its recent context, ranked by idf, matched against every event before the turn.
"""
import math
from text import content


class History:
    def __init__(self, stream):
        self.events, self.at = [], {}
        df = {}
        for s in stream["sessions"]:
            for e in s["events"]:
                if e["t"] == "tool" and not e.get("text_all"):
                    continue
                toks = content(e.get("text_all", ""))
                self.at[e["id"]] = len(self.events)
                self.events.append((s["ts"], e, toks))
                for t in toks:
                    df[t] = df.get(t, 0) + 1
        n = len(self.events)
        self.idf = {t: math.log((n + 1) / (d + 0.5)) for t, d in df.items()}

    def evidence(self, eid, base_text, responses, k=12):
        """Up to k events before `eid` that best cover the rare tokens the responses add to `base_text`."""
        base = content(base_text)
        added = set().union(*[content(r) for r in responses]) - base if responses else set()
        added = {t for t in added if self.idf.get(t, 0) > 3.0}
        if not added or eid not in self.at:
            return []
        prior = [(ts, e, toks & added) for ts, e, toks in self.events[: self.at[eid]] if toks & added]
        # greedy cover: each pick adds the most idf of still-uncovered tokens; the latest event wins ties (fresher)
        left, top = set(added), []
        while left and prior and len(top) < k:
            gain = lambda x: sum(self.idf[t] for t in x[2] & left)
            best = max(reversed(prior), key=gain)
            if gain(best) <= 0:
                break
            top.append(best)
            left -= best[2]
            prior.remove(best)
        top.sort(key=lambda x: x[0])
        return [{"when": ts, "t": e["t"], "text": e["text_all"][:700]} for ts, e, _ in top]
