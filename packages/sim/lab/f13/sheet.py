"""F13: per-world constraint sheets from a funnel --corpus-dump and the shipped card replay ($0).

    python3 -I sheet.py CORPUS.jsonl CARDS.jsonl.gz OUT.jsonl

One line per world (suite, seed, variant): the sheet (items with a constraint card, F5's rule: kind not none or
preference, not ended before the world's day 2026-10-27), each with its card and its card's requests, and the tasks
with their planted ids and whether each planted item is on the sheet. Prints the coverage table.
"""
import gzip
import json
import sys
from collections import defaultdict

TODAY = "2026-10-27"


def cards(path):
    out = {}
    with gzip.open(path, "rt") as f:
        for line in f:
            d = json.loads(line)
            h = d["h"]
            form3 = h.endswith(":f3")
            base = h.split(":")[0]
            # The shipped default reads the form-3 line (D1062); a plain line only where no form-3 line exists.
            if form3 or base not in out:
                out[base] = {"c": d["c"], "r": d.get("r", [])}
    return out


def on_sheet(card):
    c = card["c"]
    if c.get("kind") in (None, "none", "preference"):
        return False
    end = c.get("end")
    return not (end and end < TODAY)


def group(suite):
    if suite.startswith("dev20"):
        return "dev20"
    if suite == "longtail":
        return "longtail"
    if suite.endswith("r"):
        return "reworded"
    return "train"


def main():
    corpus, cpath, out = sys.argv[1:4]
    cs = cards(cpath)
    tab = defaultdict(lambda: defaultdict(int))
    sizes = defaultdict(list)
    with open(corpus) as f, open(out, "w") as w:
        for line in f:
            d = json.loads(line)
            sheet = []
            for it in d["items"]:
                card = cs.get(it["h"])
                if card and on_sheet(card):
                    sheet.append({"id": it["id"], "title": it["title"], "text": it["text"][:300], **card})
            ids = {s["id"] for s in sheet}
            carded = {it["id"] for it in d["items"] if it["h"] in cs}
            g = (group(d["suite"]), d["variant"])
            sizes[g].append(len(sheet))
            for t in d["tasks"]:
                p = t["planted"]
                if not p:
                    continue
                tab[g]["tasks"] += 1
                tab[g]["carded"] += p in carded
                tab[g]["sheet"] += p in ids
            w.write(json.dumps({k: d[k] for k in ("suite", "seed", "variant", "tasks")} | {"sheet": sheet}) + "\n")
    print("group variant: planted items carded / on the sheet, of tasks; sheet size mean (min-max)")
    for g in sorted(tab):
        t = tab[g]
        s = sizes[g]
        print(f"  {g[0]:9} {g[1]:8} carded {t['carded']}/{t['tasks']}  sheet {t['sheet']}/{t['tasks']}"
              f"  size {sum(s)/len(s):.0f} ({min(s)}-{max(s)})")


main()
