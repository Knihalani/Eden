"""List false durable extractions on no-durable items for one system in out/e3-results.json."""
import json, sys
from e3_data import ITEMS, ITEMS_B
name = sys.argv[1]
plain = {t for t, c, a in ITEMS + ITEMS_B if not a}
for e in json.load(open("out/e3-results.json"))["results"][name]["errors"]:
    if e[0] in ("slot_fp", "rule_fp") and e[1] in plain:
        print(e[0], "|", e[1][:80].replace("\n", " "), "|", e[2])
