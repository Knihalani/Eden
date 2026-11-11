#!/usr/bin/env python3
"""A static check of deploy/tofu/* without OpenTofu (D997): parses every .tf file (python-hcl2) and checks that
every `var.X` is declared, every `local.X` defined, every `<resource type>.<name>` and `data.<type>.<name>` referenced
exists, and that each templatefile() call passes exactly the variables the cloud-init template uses. It does not know
the providers' schemas: `tofu validate` (and `tofu plan`) remain the real check before an apply.

    python3 -m venv .venv-hcl && .venv-hcl/bin/pip install python-hcl2==4.3.5
    .venv-hcl/bin/python -I deploy/scripts/check-tf.py
"""
import pathlib
import re
import sys

import hcl2

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "cloud-init" / "eden.yaml.tftpl"
# Terraform's own namespaces and functions are not resources.
BUILTIN = {"var", "local", "data", "module", "path", "count", "each", "self", "terraform", "ingress_security_rules",
           "rule", "dynamic"}


def template_vars() -> set[str]:
    text = TEMPLATE.read_text()
    names = set(re.findall(r"\$\{(\w+)\}", text)) | set(re.findall(r"%\{ if (\w+) ==", text))
    return names


def check(dirpath: pathlib.Path) -> list[str]:
    problems: list[str] = []
    variables: set[str] = set()
    locals_: set[str] = set()
    resources: set[str] = set()
    datas: set[str] = set()
    texts: list[tuple[str, str]] = []
    for tf in sorted(dirpath.glob("*.tf")):
        text = tf.read_text()
        texts.append((tf.name, text))
        try:
            doc = hcl2.loads(text)
        except Exception as e:  # noqa: BLE001 - any parse error is the finding
            problems.append(f"{tf.name}: does not parse: {str(e).splitlines()[0]}")
            continue
        for v in doc.get("variable", []):
            variables.update(v.keys())
        for block in doc.get("locals", []):
            locals_.update(block.keys())
        for r in doc.get("resource", []):
            for rtype, named in r.items():
                for name in named:
                    resources.add(f"{rtype}.{name}")
        for d in doc.get("data", []):
            for dtype, named in d.items():
                for name in named:
                    datas.add(f"{dtype}.{name}")
    want = template_vars()
    for name, text in texts:
        code = re.sub(r"#.*", "", text)
        for v in set(re.findall(r"\bvar\.(\w+)", code)) - variables:
            problems.append(f"{name}: var.{v} is not declared")
        for loc in set(re.findall(r"\blocal\.(\w+)", code)) - locals_:
            problems.append(f"{name}: local.{loc} is not defined")
        for d in set(re.findall(r"\bdata\.(\w+\.\w+)", code)) - datas:
            problems.append(f"{name}: data.{d} is not defined")
        for ref in set(re.findall(r"(?<!data\.)\b((?:hcloud|aws|oci)_\w+\.\w+)\b", code)):
            if ref not in resources and not ref.endswith((".id", ".ipv4", ".name")):
                problems.append(f"{name}: {ref} is not a resource here")
        for call in re.finditer(r"templatefile\([^,]+,\s*\{(.*?)\}\)", code, re.S):
            passed = set(re.findall(r"^\s*(\w+)\s*=", call.group(1), re.M))
            if passed != want:
                problems.append(
                    f"{name}: templatefile passes {sorted(passed)}, the template uses {sorted(want)}"
                )
    return problems


def main() -> None:
    bad = 0
    for d in sorted((ROOT / "tofu").iterdir()):
        if not d.is_dir():
            continue
        problems = check(d)
        print(f"{d.name}: {'ok' if not problems else f'{len(problems)} problem(s)'}")
        for p in problems:
            print(f"  {p}")
        bad += len(problems)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
