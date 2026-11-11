#!/usr/bin/env python3
"""Users per box from measured RSS per user (docs/DEPLOY.md §6). Arithmetic, not a measurement: the inputs are.

    python3 -I deploy/scripts/sizing.py

Formula (O2's, docs/research/p6-scale.md, with the micro models added):
    users = (0.75 x RAM_MB - router 55 - N x (70 + models)) / 1.024 / RSS_per_user
0.75: a quarter of RAM left to the kernel, page cache, Docker and spikes (a thaw's peak, a backfill burst).
70 MB: a process's own RSS before any user (measured 67-90 MB; 70 on the sim's text, 90 on prose in these runs).
models: the micro CPU models' weights, one copy per process: 6 roles x 2-10 MB (upper: 60 MB).
1.024: MiB vs MB slack, as O2.
"""

# RSS per user (MB), measured 2026-11-11 with users.bench.ts, 3,000 items a user, one process in a 2-core 12 GB
# cgroup (docs/research/d1-scale-out.md §1). "Active" = used within 30 minutes; a quarter of the active ones live,
# the rest warm (p6's split), except the heavy rows, which are named by their own mix.
RSS = {
    "prose, 1/4 active": 3.06,
    "prose, 1/8 active": 2.50,
    "prose, 1/20 active": 2.00,
    "sim text, 1/4 active": 2.10,
    "sim text, 1/8 active": 1.56,
    "sim text, 1/20 active": 1.05,
    "heavy (20 connectors, prose), 1/4 active": 3.36,
    "heavy (20 connectors, prose), 1/2 active": 4.29,
    # Every user active within 30 minutes, a sixth live and the rest warm: daily agents all working the same hours.
    # The other rows were measured before D998, which lowers them too: read them as upper bounds.
    # 4.71 since D998 (5.20 on main the same day; 5.29 when first measured). With a model key, card state adds about
    # 3.7 MB: 8.43 MB at this peak (docs/research/d1-livemem.md).
    "heavy (20 connectors, prose), peak hour": 4.71,
}

BOXES = [
    # name, cores (processes), RAM GB
    ("Oracle Always Free A1 (2 OCPU, 12 GB)", 2, 12),
    ("Oracle A1 (4 OCPU, 24 GB; the old free allowance, or $55/month paid)", 4, 24),
    ("Hetzner dedicated AX41/AX42 class (64 GB)", 8, 64),
    ("Hetzner dedicated AX102 class (128 GB)", 16, 128),
]

MODELS_MB = 60  # upper bound per process
PROCESS_MB = 70
ROUTER_MB = 55


def users(ram_gb: float, n: int, rss: float) -> int:
    usable = 0.75 * ram_gb * 1024 - ROUTER_MB - n * (PROCESS_MB + MODELS_MB)
    return int(usable / 1.024 / rss)


def main() -> None:
    import sys

    extra = {}
    for arg in sys.argv[1:]:
        name, _, value = arg.partition("=")
        extra[name] = float(value)
    rss = {**RSS, **extra}
    for box, n, ram in BOXES:
        print(f"\n{box}: EDEN_PROCESSES={n}")
        for label, mb in rss.items():
            print(f"  {label:<46} {mb:5.2f} MB/user  {users(ram, n, mb):>7,} users")


if __name__ == "__main__":
    main()
