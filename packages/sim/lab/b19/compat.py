"""B19 (D1047): makes the harnesses load against an Eden tree that predates an engine export they name.

An Eden arm at an older commit (arm-tree.sh) runs today's pi-ab and hermes-ab against that commit's engine. A
harness's named import of an export the old engine lacks fails the whole module at load (Bun: "Export named … not
found"), even when only the newer default reads it. This rewrites such imports to a namespace read with a fallback
that means "off" in the old engine. Idempotent; run from the repo root after merging the final main:

    python3 -I packages/sim/lab/b19/compat.py && git diff --stat

Each entry: the export, the value that means the feature is absent, and the files that import it.
"""
import os
import re

FALLBACKS = {
    # H2 (D1060, D1063): the card prompt's form; an engine with no `cardsRequestsFix` asks in form 0.
    "CARD_FORM_REQUESTS": ("0", ["packages/sim/src/lab/pi-ab.ts", "packages/sim/src/lab/hermes-ab.ts"]),
}
# One `import { … } from "@eden/engine";` block (no `}` inside the braces).
ENGINE_IMPORT = re.compile(r'import \{\n[^}]*\} from "@eden/engine";\n')

for name, (fallback, files) in FALLBACKS.items():
    for path in files:
        if not os.path.exists(path):
            continue
        s = open(path).read()
        named = f"  {name},\n"
        m = next((m for m in ENGINE_IMPORT.finditer(s) if named in m.group(0)), None)
        if m is None:
            continue  # already rewritten, or not imported by name
        shim = (
            'import * as engineExports from "@eden/engine";\n'
            "// B19 (D1047): read so an older engine without it loads (packages/sim/lab/b19/compat.py).\n"
            f"const {name} = (engineExports as {{ {name}?: number }}).{name} ?? {fallback};\n"
        )
        s = s[: m.start()] + m.group(0).replace(named, "", 1) + shim + s[m.end() :]
        open(path, "w").write(s)
        print(f"compat: {path}: {name} read through the namespace (fallback {fallback})")
