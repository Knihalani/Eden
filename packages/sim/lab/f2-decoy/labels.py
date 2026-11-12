"""F2-decoy: each template's labelled decoy kind, read from the suite sources' own comments (no model).

dev20a-d mark each template `decoy: (a) …|(b) …|(c) …` in the comment above it; longtail marks `decoy (a): …`.
Other suites carry no kind label. Returns {template name: "a"|"b"|"c"}.
"""
import os
import re

LAB = os.path.join(os.path.dirname(__file__), "../../src/lab")
FILES = ["hidden-dev20a.ts", "hidden-dev20b.ts", "hidden-dev20c.ts", "hidden-dev20d.ts", "hidden-longtail.ts"]
KIND = re.compile(r"decoy:?\s*\(([abc])\)")
NAME = re.compile(r'name:\s*"([^"]+)"')


def labels():
    out = {}
    for f in FILES:
        pending = None
        for line in open(os.path.join(LAB, f)):
            if line.strip().startswith("//"):
                m = KIND.search(line)
                if m:
                    pending = m.group(1)
                continue
            m = NAME.search(line)
            if m and pending:
                out[m.group(1)] = pending
                pending = None
    return out


if __name__ == "__main__":
    import collections

    ls = labels()
    print(len(ls), collections.Counter(ls.values()))
