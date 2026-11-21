#!/usr/bin/env python3
"""A dry-run autoscale plan for the Eden fleet (S1-P5, docs/research/s1-scale-1m.md): /metrics from every node to a
node count, with hysteresis and a peak-hour guard. It never changes anything: the output is a plan to apply by hand —
a node_count for the tofu varset, and (with --cidr) the nodes-file lines a new count implies.

    # live: the nodes file's urls (each node's /metrics answers on the private network)
    python3 -I deploy/scripts/autoscale-plan.py --nodes-file nodes.txt --ram-gb 128 --processes 16

    # offline: --metrics-dir reads <id>.metrics files instead of HTTP (tests, postmortems)
    python3 -I deploy/scripts/autoscale-plan.py --metrics-dir samples/ --nodes-file nodes.txt

Model (sizing.py's, docs/DEPLOY.md §6): a box holds (0.75 x RAM_MB - router 55 - N x (70 + models 60)) / 1.024 /
rss_per_user. The fleet's per-user cost is measured live — resident bytes over users held, the fullest node's —
with --rss-per-user as the floor, and the count plans for projected peak users = held x --peak-factor (the soak's
peaks run ~22% over the mean, D1075). Scaling out is immediate; scaling in waits --confirm-in consecutive readings
below the need and never happens inside --peak-hours (a scale-in at peak is a capacity cut before the day's high).
One membership change moves at most --max-move-frac of nodes (P6: users spread evenly, so nodes bound users).

A node that does not answer counts as full: a plan on missing data only ever adds, never removes.
"""

import json
import math
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field

ROUTER_MB = 55
PROCESS_MB = 70
MODELS_MB = 60

WANT = [
    "eden_users_held",
    "eden_process_resident_bytes",
    "eden_processes_ready",
    "eden_sync_users_waiting_first_page",
    "eden_sync_kick_queue_users",
]


@dataclass
class Node:
    id: str
    url: str
    users: int = 0
    rss_mb: float = 0.0
    ready: int = 1
    waiting_first_page: int = 0
    kick_queued: int = 0
    down: bool = False


def parse_nodes_file(text: str) -> list[Node]:
    """`id=url` lines, as EDEN_NODES_FILE (cluster.ts parseNodes)."""
    nodes = []
    for line in re.split(r"[\n,]", text):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        ident, sep, url = line.partition("=")
        if not sep or not ident.strip() or not url.strip():
            raise SystemExit(f"nodes file: bad line {line!r} (want id=url)")
        nodes.append(Node(ident.strip(), url.strip().rstrip("/")))
    if not nodes:
        raise SystemExit("nodes file: no nodes")
    return nodes


def parse_metrics(text: str, n: Node) -> None:
    found = dict.fromkeys(WANT, None)
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        name = re.split(r"[{\s]", line, maxsplit=1)[0]
        if name in found and found[name] is None:
            found[name] = float(line.rsplit(" ", 1)[1])
    for k, v in found.items():
        if v is None:
            raise ValueError(f"missing {k}")
    n.users = int(found["eden_users_held"])
    n.rss_mb = found["eden_process_resident_bytes"] / 1_048_576
    n.ready = int(found["eden_processes_ready"])
    n.waiting_first_page = int(found["eden_sync_users_waiting_first_page"])
    n.kick_queued = int(found["eden_sync_kick_queue_users"])


def scrape(n: Node, timeout: float) -> None:
    try:
        with urllib.request.urlopen(n.url + "/metrics", timeout=timeout) as r:
            parse_metrics(r.read().decode(), n)
    except Exception:
        n.down = True


def in_peak(now: float, hours: str) -> bool:
    a, _, b = hours.partition("-")
    lo, hi = int(a), int(b)
    h = time.localtime(now).tm_hour
    return lo <= h < hi if lo <= hi else h >= lo or h < hi  # 19-7 wraps midnight


def usable_mb(ram_gb: float, processes: int) -> float:
    return 0.75 * ram_gb * 1024 - ROUTER_MB - processes * (PROCESS_MB + MODELS_MB)


def plan(args: dict, nodes: list[Node], now: float) -> dict:
    count = len(nodes)
    per_users = [n.rss_mb / n.users for n in nodes if not n.down and n.users > 0]
    rss_plan = max([*per_users, args["rss_per_user"]])
    users_per_box = usable_mb(args["ram_gb"], args["processes"]) / 1.024 / rss_plan
    # A node's user count is missing data when it did not answer, or partial when fewer children answered /metrics
    # than --processes run there (the node's router sums only responding children): estimate both from what is
    # seen — a partial node's count scales by the missing share, a silent node's by the live nodes' mean (the
    # fleet spreads users evenly), or a whole box's planned users when nothing answered. Missing data never
    # shrinks the fleet and never erases demand.
    missing = []
    measured = []
    for n in nodes:
        if n.down:
            missing.append(n)
        elif n.ready <= 0:
            measured.append(users_per_box)
        elif n.ready < args["processes"]:
            measured.append(n.users * args["processes"] / n.ready)
        else:
            measured.append(n.users)
    fill = (sum(measured) / len(measured)) if measured else users_per_box
    total = sum(measured) + len(missing) * fill
    partial = any(not n.down and n.ready < args["processes"] for n in nodes)
    any_down = bool(missing) or partial
    projected = total * args["peak_factor"]
    need_load = math.ceil(projected / users_per_box) if users_per_box > 0 else count
    urgent = [n.id for n in nodes if not n.down and n.rss_mb > 0.85 * args["ram_gb"] * 1024]
    need = max(need_load, count + 1 if urgent else 0) + args["spares"]
    need = max(need, 1)

    max_move = max(1, math.floor(args["max_move_frac"] * count))
    move = max(-max_move, min(max_move, need - count))
    target = count + move

    state_path = args["state"]
    streak = 0
    if os.path.exists(state_path):
        try:
            streak = json.loads(open(state_path).read()).get("below_streak", 0)
        except Exception:
            streak = 0
    below = need < count
    streak = streak + 1 if below else 0
    hold_in = ""
    if target < count:
        if any_down:
            hold_in = "a node did not answer or reports partial data: holding (missing data never shrinks the fleet)"
        elif in_peak(now, args["peak_hours"]):
            hold_in = f"inside peak hours {args['peak_hours']}: holding"
        elif streak < args["confirm_in"]:
            hold_in = f"below need for {streak} of {args['confirm_in']} consecutive readings: holding"
        if hold_in:
            target = count
    with open(state_path, "w") as f:
        f.write(json.dumps({"below_streak": streak, "ts": now}))

    return {
        "count": count,
        "target": target,
        "need": need,
        "need_load": need_load,
        "total_users": total,
        "projected": int(projected),
        "rss_plan": round(rss_plan, 2),
        "users_per_box": int(users_per_box),
        "urgent": urgent,
        "any_down": any_down,
        "hold_in": hold_in,
        "streak": streak,
        "waiting_first_page": sum(n.waiting_first_page for n in nodes),
        "kick_queued": sum(n.kick_queued for n in nodes),
    }


def main() -> int:
    import argparse

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--nodes-file", required=True)
    p.add_argument("--metrics-dir", help="read <id>.metrics files instead of scraping http")
    p.add_argument("--ram-gb", type=float, required=True)
    p.add_argument("--processes", type=int, required=True)
    p.add_argument("--rss-per-user", type=float, default=4.71, help="floor MB a user (default: the peak soak)")
    p.add_argument("--peak-factor", type=float, default=1.22)
    p.add_argument("--spares", type=int, default=1)
    p.add_argument("--max-move-frac", type=float, default=0.10)
    p.add_argument("--confirm-in", type=int, default=3)
    p.add_argument("--peak-hours", default="7-19", help="local hours that block scale-in, e.g. 7-19")
    p.add_argument("--state", default=".eden-autoscale.json")
    p.add_argument("--cidr", help="nodes' private CIDR (tofu: cidrhost N+10): renders the new nodes-file lines")
    p.add_argument("--timeout", type=float, default=5.0)
    p.add_argument("--now", type=float, default=None, help="unix time (tests); default now")
    args = vars(p.parse_args())
    now = args["now"] if args["now"] is not None else time.time()

    nodes = parse_nodes_file(open(args["nodes_file"]).read())
    if args["metrics_dir"]:
        for n in nodes:
            try:
                parse_metrics(open(os.path.join(args["metrics_dir"], n.id + ".metrics")).read(), n)
            except Exception:
                n.down = True
    else:
        for n in nodes:
            scrape(n, args["timeout"])

    out = plan(args, nodes, now)
    print(f"{'node':<8}{'users':>7}{'rss GB':>8}{'MB/user':>9}{'ready':>6}  note")
    for n in nodes:
        per = n.rss_mb / n.users if n.users else 0
        print(
            f"{n.id:<8}{n.users:>7}{n.rss_mb / 1024:>8.1f}{per:>9.2f}{n.ready:>6}"
            f"  {'DOWN (counts as full)' if n.down else 'urgent' if n.id in out['urgent'] else ''}"
        )
    print(
        f"\nfleet: {out['count']} nodes, {out['total_users']} users held, "
        f"{out['rss_plan']} MB a user planned (floor + fullest node), "
        f"{out['users_per_box']} users a box of {args['ram_gb']} GB x {args['processes']} processes"
    )
    print(
        f"projected peak {out['projected']} users (x{args['peak_factor']}) → need {out['need_load']} "
        f"+ {args['spares']} spare; backlog: {out['waiting_first_page']} waiting first page, "
        f"{out['kick_queued']} kick-queued"
    )
    if out["urgent"]:
        print(f"URGENT: {', '.join(out['urgent'])} over 85% RSS — scale out now")
    if out["hold_in"]:
        print(f"scale-in held: {out['hold_in']}")
    delta = out["target"] - out["count"]
    if delta == 0:
        print(f"\nplan: keep {out['count']} nodes")
        return 0
    bounded = out["need"] - out["count"] != delta
    print(
        f"\nplan: {'add' if delta > 0 else 'remove'} {abs(delta)} node(s) → {out['target']}"
        + (f" (move bounded to {args['max_move_frac']:.0%} of the fleet)" if bounded else "")
    )
    print(f"  tofu: node_count = {out['target']}")
    if args["cidr"]:
        import ipaddress

        net = ipaddress.ip_network(args["cidr"])
        lines = []
        for i in range(out["target"]):
            ip = net.network_address + 11 + i  # tofu: cidrhost(private_cidr, 11 + i)
            lines.append(f"n{i + 1}=http://{ip}:8790")
        print("  nodes file:")
        for line in lines:
            print(f"    {line}")
    else:
        print("  nodes file: regenerated by the tofu output (or pass --cidr to render it here)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
