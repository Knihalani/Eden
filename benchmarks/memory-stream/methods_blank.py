"""Blank-slate retrieval (C3). See BLANK-C3.md."""
import math, re
from text import content, stems, raw_tokens

NONHUMAN = ("notification", "peer")


def params(spec):
    name, _, rest = spec.partition(":")
    kv = {}
    for part in filter(None, rest.split(",")):
        k, _, v = part.partition("=")
        kv[k] = float(v) if re.fullmatch(r"-?[0-9.]+", v) else v
    return name, kv


SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Za-z0-9\"'(])|\n+|\s+/\s+")
CODE = set("{}();=<>[]`|$\\")


def split_units(text):
    parts = [p.strip() for p in SENT.split(text or "") if p and p.strip()]
    out, buf = [], ""
    for p in parts:
        buf = (buf + " " + p).strip() if buf else p
        if len(content(buf)) >= 3:
            out.append(buf)
            buf = ""
    if buf and out:
        out[-1] = out[-1] + " " + buf
    elif buf:
        out.append(buf)
    return out


def codey(s):
    return sum(1 for c in s if c in CODE) / max(1, len(s))


class Blank:
    def __init__(self, rows, stream, items, cov, **kw):
        self.kw = kw
        self.k = int(kw.get("k", 4))
        self.tau = kw.get("tau", 4.0)
        self.nov = kw.get("nov", 0.4)
        self.cov = cov
        # --- stream: flat events and window boundaries (only earlier events are ever read) ---
        flat, start = [], {}
        ws = 0
        for s in stream["sessions"]:
            if s["kind"] != "resume":
                ws = len(flat)
            for e in s["events"]:
                if e["t"] == "compact":
                    ws = len(flat)
                start[e["_order"]] = ws
                flat.append(e)
        self.flat = flat
        self.pos = {e["_order"]: i for i, e in enumerate(flat)}
        self.start = start
        self._stems = {}
        # --- units ---
        units = []
        for r in rows:
            for j, u in enumerate(split_units(r["text"])):
                if codey(u) > 0.04:
                    continue
                c = content(u)
                if len(c) < 3:
                    continue
                units.append({"id": f"{r['id']}#{j}", "text": u, "t": r["t"], "invalid_at": r.get("invalid_at"),
                              "c": c, "src": r["id"]})
        tmpl = {}
        for u in units:
            key = re.sub(r"[0-9a-f]{6,}|\d+", "#", u["text"].lower())
            u["key"] = key
            tmpl[key] = tmpl.get(key, 0) + 1
        units = [u for u in units if tmpl[u["key"]] < 4]
        df = {}
        for u in units:
            for t in u["c"]:
                df[t] = df.get(t, 0) + 1
        n = len(units)
        self.idf = {t: math.log(1 + n / d) for t, d in df.items()}
        self.inv = {}
        for u in units:
            u["w"] = sum(self.idf[t] for t in u["c"])
            for t in u["c"]:
                self.inv.setdefault(t, []).append(u)
            u["covers"] = cov.covers(u["text"])
        self.units = units
        self.by_id = {u["id"]: u for u in units}

    def ev_stems(self, e):
        s = self._stems.get(e["_order"])
        if s is None:
            s = self._stems[e["_order"]] = stems(e["text_all"])
        return s

    def window(self, e):
        i = self.pos[e["_order"]]
        w = set()
        for x in self.flat[self.start[e["_order"]]:i]:
            w |= self.ev_stems(x)
        return w

    def query_text(self, e):
        txt = e["text_all"]
        lines = txt.splitlines()
        if len(lines) > 12:  # a paste: keep the ask around it
            txt = "\n".join(lines[:3] + lines[-3:])
        return txt

    def packet(self, e, now):
        cls = e["labels"]["class"]
        if cls in NONHUMAN:
            return []
        q = self.query_text(e)
        qc = content(q)
        if len(qc) < 2:
            return []
        qs = stems(q)
        win = self.window(e) | qs
        cand = {}
        for t in qc:
            for u in self.inv.get(t, ()):
                if u["t"] < now and (u["invalid_at"] is None or u["invalid_at"] > now):
                    cand[u["id"]] = u
        scored = []
        for u in cand.values():
            m = sum(self.idf[t] for t in u["c"] if t in qc)
            novel = sum(self.idf[t] for t in u["c"] if t not in win) / u["w"]
            if novel < self.nov:
                continue
            scored.append((m * novel, u))
        scored.sort(key=lambda x: (-x[0], -x[1]["t"]))
        out = []
        for s, u in scored:
            if s < self.tau or len(out) >= self.k:
                break
            if any(len(u["c"] & v["c"]) / len(u["c"] | v["c"]) > 0.5 for v in out):
                continue
            out.append(u)
        return [u["id"] for u in out]


REGISTRY = {"blank": Blank}
