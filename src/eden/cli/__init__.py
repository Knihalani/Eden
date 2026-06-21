"""eden-ops — minimal ops CLI for Eden orgs.

Replaces the deleted `eden` Python CLI documented in pyproject.toml.
Uses stdlib argparse + httpx to call existing REST endpoints. No
business logic is reimplemented — every command is a thin
front-end on a route that's already mounted in ``app.py``.

Subcommands
-----------
rotate-key       Rotate (delete + create) an org API key
dump-trace       Dump a trace's full step payload as JSON
replay           Replay a trace to its current checkpoint
list-members     List org members
change-role      Change a member's role (owner|admin|member|viewer)
archive-org      Archive an org (soft-delete)

Auth
----
Pass an Eden API key via ``--api-key`` or ``EDEN_API_KEY``. The
base URL defaults to ``http://localhost:8000``; override with
``--api-url`` or ``EDEN_API_URL``.
"""

import argparse
import json
import os
import sys
from typing import Any

import httpx


def _client(api_url: str, api_key: str | None) -> httpx.Client:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return httpx.Client(base_url=api_url, headers=headers, timeout=30.0)


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


# ── Subcommand handlers ──────────────────────────────────────────────


def cmd_rotate_key(args: argparse.Namespace) -> int:
    """Delete the key, then create a new one with the same name."""
    with _client(args.api_url, args.api_key) as c:
        keys = c.get(f"/orgs/{args.org}/api-keys").json()
        target = next((k for k in keys if k.get("id") == args.key_id), None)
        if target is None:
            print(f"key {args.key_id} not found", file=sys.stderr)
            return 2
        c.delete(f"/orgs/{args.org}/api-keys/{args.key_id}")
        new_key = c.post(
            f"/orgs/{args.org}/api-keys",
            json={"name": target["name"], "scopes": target.get("scopes", [])},
        ).json()
        _print(new_key)
        print("\n>>> New key — copy now; the secret is only shown once.", file=sys.stderr)
    return 0


def cmd_dump_trace(args: argparse.Namespace) -> int:
    with _client(args.api_url, args.api_key) as c:
        trace = c.get(f"/orgs/{args.org}/traces/{args.trace_id}").json()
        _print(trace)
    return 0


def cmd_replay(args: argparse.Namespace) -> int:
    with _client(args.api_url, args.api_key) as c:
        result = c.post(
            f"/orgs/{args.org}/intelligence/replay/checkpoint",
            json={"trace_id": args.trace_id, "checkpoint_id": args.checkpoint_id or None},
        ).json()
        _print(result)
    return 0


def cmd_list_members(args: argparse.Namespace) -> int:
    with _client(args.api_url, args.api_key) as c:
        members = c.get(f"/orgs/{args.org}/members").json()
        if args.json:
            _print(members)
        else:
            for m in members:
                role = m.get("role", "?")
                print(f"{m.get('user_id', m.get('email', '?'))}\t{role}\t{m.get('email', '')}")
    return 0


def cmd_change_role(args: argparse.Namespace) -> int:
    with _client(args.api_url, args.api_key) as c:
        result = c.patch(
            f"/orgs/{args.org}/members/{args.user_id}",
            json={"role": args.role},
        )
        if result.status_code >= 400:
            print(f"failed: {result.status_code} {result.text}", file=sys.stderr)
            return 1
        _print(result.json())
    return 0


def cmd_archive_org(args: argparse.Namespace) -> int:
    with _client(args.api_url, args.api_key) as c:
        result = c.post(f"/orgs/{args.org}/archive")
        if result.status_code >= 400:
            print(f"failed: {result.status_code} {result.text}", file=sys.stderr)
            return 1
        _print(result.json())
    return 0


# ── Parser ───────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="eden-ops",
        description="Eden ops CLI. Thin front-end on existing REST routes.",
    )
    p.add_argument(
        "--api-url",
        default=os.environ.get("EDEN_API_URL", "http://localhost:8000"),
        help="Backend URL (default: EDEN_API_URL or http://localhost:8000)",
    )
    p.add_argument(
        "--api-key",
        default=os.environ.get("EDEN_API_KEY"),
        help="API key (default: EDEN_API_KEY)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("rotate-key", help="Delete + recreate an org API key")
    s.add_argument("--org", required=True)
    s.add_argument("--key-id", required=True)
    s.set_defaults(func=cmd_rotate_key)

    s = sub.add_parser("dump-trace", help="Dump a full trace as JSON")
    s.add_argument("--org", required=True)
    s.add_argument("--trace-id", required=True)
    s.set_defaults(func=cmd_dump_trace)

    s = sub.add_parser("replay", help="Replay a trace to a checkpoint")
    s.add_argument("--org", required=True)
    s.add_argument("--trace-id", required=True)
    s.add_argument("--checkpoint-id", default=None)
    s.set_defaults(func=cmd_replay)

    s = sub.add_parser("list-members", help="List org members")
    s.add_argument("--org", required=True)
    s.add_argument("--json", action="store_true", help="Emit JSON instead of TSV")
    s.set_defaults(func=cmd_list_members)

    s = sub.add_parser("change-role", help="Change a member's role")
    s.add_argument("--org", required=True)
    s.add_argument("--user-id", required=True)
    s.add_argument("--role", required=True, choices=["owner", "admin", "member", "viewer"])
    s.set_defaults(func=cmd_change_role)

    s = sub.add_parser("archive-org", help="Archive (soft-delete) an org")
    s.add_argument("--org", required=True)
    s.set_defaults(func=cmd_archive_org)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except httpx.HTTPError as e:
        print(f"HTTP error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
