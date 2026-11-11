#!/usr/bin/env python3
"""Renders deploy/cloud-init/eden.yaml.tftpl outside OpenTofu (docs/DEPLOY.md §2): for a Hetzner dedicated server
(no Terraform provider) or any VM whose console takes user data. Supports the template's subset of Terraform's
syntax: ${name} and %{ if role == "..." ~} ... %{ else ~} ... %{ endif ~}.

    python3 -I deploy/scripts/render-cloud-init.py --role single --ref main \\
      --git-url https://github.com/KaiavN/Eden.git --admin-cidr 203.0.113.4/32 > user-data.yaml
"""
import argparse
import pathlib
import re
import sys

TEMPLATE = pathlib.Path(__file__).resolve().parent.parent / "cloud-init" / "eden.yaml.tftpl"
COMPOSE_DIR = {"single": "single", "node": "node", "router": "cluster-router"}


def render(text: str, values: dict[str, str]) -> str:
    def branch(m: re.Match[str]) -> str:
        var, want, yes, no = m.group(1), m.group(2), m.group(3), m.group(4) or ""
        return yes if values[var] == want else no

    text = re.sub(
        r'%\{ if (\w+) == "([^"]*)" ~\}\n(.*?)(?:%\{ else ~\}\n(.*?))?%\{ endif ~\}\n',
        branch,
        text,
        flags=re.S,
    )

    def var(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in values:
            sys.exit(f"render-cloud-init: the template names ${{{name}}}, which has no value")
        return values[name]

    out = re.sub(r"\$\{(\w+)\}", var, text)
    if "%{" in out or "${" in out:
        sys.exit("render-cloud-init: a template directive was left unrendered")
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--role", choices=sorted(COMPOSE_DIR), required=True)
    p.add_argument("--ref", required=True, help="git tag or branch to build")
    p.add_argument("--git-url", required=True)
    p.add_argument("--admin-cidr", required=True, help="where SSH is allowed from")
    p.add_argument("--private-cidr", default="10.0.1.0/24", help="the private network nodes take traffic from")
    a = p.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F:.]+/\d{1,3}", a.admin_cidr):
        sys.exit("render-cloud-init: --admin-cidr must be an address range such as 203.0.113.4/32")
    values = {
        "role": a.role,
        "compose_dir": COMPOSE_DIR[a.role],
        "eden_ref": a.ref,
        "eden_git_url": a.git_url,
        "admin_cidr": a.admin_cidr,
        "private_cidr": a.private_cidr,
    }
    sys.stdout.write(render(TEMPLATE.read_text(), values))


if __name__ == "__main__":
    main()
