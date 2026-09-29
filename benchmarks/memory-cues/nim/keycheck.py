"""Check that the NVIDIA API key (read from .env, never printed) and any nvapi- token appear in no deliverable file."""
import os, re, sys
from nim import env
key = env()["NVIDIA_API_KEY"]
roots = sys.argv[1:]
hits = 0; n = 0
for root in roots:
    for dp, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f); n += 1
            try:
                b = open(p, "rb").read()
            except Exception:
                continue
            if key.encode() in b or re.search(rb"nvapi-[A-Za-z0-9_\-]{10,}", b) or (len(key) > 12 and key[4:16].encode() in b):
                hits += 1; print("MATCH in", p)
print(f"scanned {n} files; files containing the key or an nvapi- token: {hits}")
