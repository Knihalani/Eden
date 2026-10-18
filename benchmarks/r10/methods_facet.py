"""F3 — compositional need predicates: entity × activity, compiled at sleep, matched by lookup at hook time.

The sleep compiler names, for every memory, the entities it is about and the activities in which it matters
(COMPILE-SPEC.md), and writes the user's gazetteer (aliases incl. role words) and activity lexicon. At hook time the
situation text is matched against both dictionaries; a memory is needed when the situation is *about one of its
entities while doing one of its activities*. The product generalises to unseen combinations ("book a hotel for Sam's
parents" = Grace & Daniel × lodging) without an exemplar of that combination, which a cue bank needs.

score(m) = we*E + wa*A + wea*E*A + wl * L/(L+1)
  E = 1 if an entity of m is mentioned (alias match), A = 1 if an activity of m fires, L = BM25F(situation, m).
"""
from compiled import load_compiled, PhraseMatcher
from methods_lex import BM25


class Facet:
    def __init__(self, fx, we=0.3, wa=0.25, wea=0.6, wl=0.5, act_min=1):
        user, mem = load_compiled(fx.name)
        self.fx, self.mem = fx, mem
        self.w = (we, wa, wea, wl)
        self.act_min = act_min
        self.ent = PhraseMatcher({e["name"]: [e["name"]] + e.get("aliases", []) for e in user["entities"]})
        self.act = PhraseMatcher({a["name"]: [a["name"]] + a.get("words", []) for a in user["activities"]})
        self.lex = BM25(fx, ctx=True)

    def parse(self, c):
        text = " ".join(x for x in [c["cue"], c.get("prev_turn") or ""] if x)
        return self.ent.find(text), self.act.find(text)

    def scores(self, c):
        ents, acts = self.parse(c)
        L = self.lex.scores(c)
        we, wa, wea, wl = self.w
        out = {}
        for m in self.fx.visible(c):
            e = self.mem.get(m["id"], {})
            E = 1.0 if any(x in ents for x in e.get("entities", [])) else 0.0
            A = 1.0 if sum(1 for x in e.get("activities", []) if x in acts) >= self.act_min else 0.0
            lx = L.get(m["id"], 0.0)
            s = we * E + wa * A + wea * E * A + wl * lx / (lx + 1.0)
            if s > 0:
                out[m["id"]] = s
        return out
