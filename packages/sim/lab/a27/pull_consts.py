# A27: reads (never executes) named top-level string constants from hermes-agent source files with ast; writes JSON.
# usage: python3 -I pull_consts.py OUT.json NAME,NAME,... FILE [FILE ...]
import ast, json, sys
want = set(sys.argv[2].split(","))
out = {}
for path in sys.argv[3:]:
    tree = ast.parse(open(path).read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in want:
                try:
                    v = ast.literal_eval(node.value)
                except Exception:
                    # Implicitly concatenated / parenthesised strings are literals; f-strings are not.
                    continue
                if isinstance(v, str):
                    out[name] = v
json.dump(out, open(sys.argv[1], "w"), indent=1)
print({k: len(v) for k, v in out.items()})
