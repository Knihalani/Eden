#!/usr/bin/env python3
"""
Greedy wave-scheduler for the strategic-review-2026-08 action items.

Loads the four WAVE-META source files, merges them, validates/repairs
dependency edges (dangling refs dropped, cycles broken), then greedily
assigns each point to the earliest wave in which:
  - all its dependencies are already placed in a strictly earlier wave, and
  - none of its `files` overlap with files already claimed in that wave.

Priority order for greedy placement: severity (Critical > High > Medium > Low),
then rank ascending (within severity). This also governs cycle-breaking and
file-contention tie-breaks, since points are simply processed in this order
and earlier points "claim" waves/files first.

Output: docs/specs/strategic-review-2026-08/_pass4-notes/WAVE-ASSIGNMENT.json
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))

SOURCE_FILES = [
    "WAVE-META-bugs.json",
    "WAVE-META-optimizations.json",
    "WAVE-META-features-1.json",
    "WAVE-META-features-2.json",
]

SEVERITY_ORDER = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}

OUTPUT_FILE = os.path.join(BASE, "WAVE-ASSIGNMENT.json")


def load_points():
    points = []
    seen_ids = {}
    for fname in SOURCE_FILES:
        path = os.path.join(BASE, fname)
        with open(path) as f:
            data = json.load(f)
        for pt in data:
            pid = pt["id"]
            if pid in seen_ids:
                print(
                    f"WARNING: duplicate id '{pid}' found in {fname} "
                    f"(already loaded from {seen_ids[pid]}) -- keeping first occurrence, dropping duplicate."
                )
                continue
            seen_ids[pid] = fname
            points.append(pt)
    return points


def priority_key(pt):
    """Lower key sorts first (higher priority)."""
    return (SEVERITY_ORDER.get(pt["severity"], 99), pt["rank"])


def validate_dependencies(points):
    """Drop dangling depends_on references (ids that don't exist in the merged set)."""
    valid_ids = {pt["id"] for pt in points}
    dangling_count = 0
    for pt in points:
        deps = pt.get("depends_on") or []
        kept = []
        for dep in deps:
            if dep in valid_ids:
                kept.append(dep)
            else:
                dangling_count += 1
                print(
                    f"WARNING: dangling dependency '{dep}' referenced by '{pt['id']}' "
                    f"does not resolve to any known id -- dropping this edge."
                )
        pt["depends_on"] = kept
    if dangling_count == 0:
        print("No dangling dependency references found.")
    else:
        print(f"Dropped {dangling_count} dangling dependency reference(s) total.")
    return points


def _find_one_cycle(points):
    """
    Return a list of node ids forming one cycle (in edge order,
    e.g. [a, b, c] meaning a->b->c->a), or None if the graph is acyclic.
    """
    by_id = {pt["id"]: pt for pt in points}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {pt["id"]: WHITE for pt in points}

    def dfs(node_id, stack):
        color[node_id] = GRAY
        stack.append(node_id)
        for dep in by_id[node_id].get("depends_on") or []:
            if dep not in by_id:
                continue
            if color[dep] == WHITE:
                found = dfs(dep, stack)
                if found is not None:
                    return found
            elif color[dep] == GRAY:
                return stack[stack.index(dep):]
        stack.pop()
        color[node_id] = BLACK
        return None

    for pt in sorted(points, key=priority_key):
        if color[pt["id"]] == WHITE:
            found = dfs(pt["id"], [])
            if found is not None:
                return found
    return None


def break_cycles(points):
    """
    Detect circular dependencies via DFS. Repeatedly find a cycle and break it
    by dropping the dependency edge that originates at the lower-priority
    (worse severity, then higher rank) item in the cycle -- i.e. the edge from
    that item to the next node in the cycle is removed, since it's the
    "least important" link to preserve. Repeat until no cycles remain.
    """
    by_id = {pt["id"]: pt for pt in points}
    cycles_broken = 0

    while True:
        cycle = _find_one_cycle(points)
        if cycle is None:
            break
        pkey = {pt["id"]: priority_key(pt) for pt in points}
        worst = max(cycle, key=lambda n: pkey[n])
        idx = cycle.index(worst)
        target = cycle[(idx + 1) % len(cycle)]
        worst_pt = by_id[worst]
        deps = worst_pt.get("depends_on") or []
        if target in deps:
            deps.remove(target)
            worst_pt["depends_on"] = deps
            cycles_broken += 1
            print(
                f"WARNING: circular dependency detected among {cycle} -- "
                f"dropping edge '{worst}' -> '{target}' "
                f"(breaking at lowest-priority item '{worst}')."
            )
        else:
            # Safety net: should not happen, but avoid infinite loop.
            print(
                f"WARNING: cycle {cycle} detected but expected edge "
                f"'{worst}' -> '{target}' not found; aborting cycle-break loop."
            )
            break

    if cycles_broken == 0:
        print("No circular dependencies found.")
    else:
        print(f"Broke {cycles_broken} circular dependency edge(s) total.")

    return points


MAX_POINTS_PER_WAVE = 20


def schedule_waves(points):
    """
    Greedy wave assignment using a priority-ordered topological process
    (Kahn's algorithm with a priority tie-break), with a hard capacity cap
    per wave (capacity-constrained bin-packing rather than pure "minimize
    wave count").

    A fixed static priority order (severity desc, then rank asc) is not
    guaranteed to be a valid topological order of the dependency graph --
    a high-priority point can depend on a lower-priority one. So instead of
    iterating points in one fixed pass, we maintain a "ready" set of points
    whose dependencies have ALL already been assigned a wave, and repeatedly
    pick the highest-priority point from that ready set. This guarantees
    rule 2 (dependencies placed in a strictly earlier wave) always holds,
    while still respecting rule 3's priority ordering to the maximum extent
    the dependency graph allows.

    For the chosen point, find the earliest wave index W (0-indexed here,
    converted to 1-indexed on output) such that:
      - all depends_on ids are already assigned to a wave < W
      - none of the point's files overlap with files already claimed in wave W
      - wave W currently holds fewer than MAX_POINTS_PER_WAVE points
    Assign the point there, and add its files to that wave's claimed set
    and increment that wave's point count. If no existing wave satisfies
    all three conditions, a new (empty) wave is opened.
    """
    import heapq

    by_id = {pt["id"]: pt for pt in points}

    # dependents[x] = list of point ids that depend on x
    dependents = defaultdict(list)
    remaining_deps = {}  # id -> count of not-yet-assigned dependencies
    for pt in points:
        deps = pt.get("depends_on") or []
        remaining_deps[pt["id"]] = len(deps)
        for d in deps:
            dependents[d].append(pt["id"])

    wave_assignment = {}  # id -> wave index (0-indexed)
    wave_claimed_files = defaultdict(set)  # wave index -> set of claimed files
    wave_counts = defaultdict(int)  # wave index -> number of points assigned

    # Min-heap of ready points, ordered by (severity_order, rank, id) for
    # deterministic tie-breaking.
    heap = []
    for pt in points:
        if remaining_deps[pt["id"]] == 0:
            heapq.heappush(heap, (*priority_key(pt), pt["id"]))

    assigned_count = 0
    while heap:
        _, _, pid = heapq.heappop(heap)
        pt = by_id[pid]
        deps = pt.get("depends_on") or []
        files = pt.get("files") or []

        # Earliest wave allowed by dependency constraints: one past the max
        # wave of any dependency (0 if no deps). All deps are guaranteed to
        # already be assigned since this point is in the ready set.
        if deps:
            min_wave = max(wave_assignment[d] for d in deps) + 1
        else:
            min_wave = 0

        w = min_wave
        while True:
            claimed = wave_claimed_files[w]
            under_capacity = wave_counts[w] < MAX_POINTS_PER_WAVE
            no_conflict = not files or claimed.isdisjoint(files)
            if under_capacity and no_conflict:
                break
            w += 1

        wave_assignment[pid] = w
        for f in files:
            wave_claimed_files[w].add(f)
        wave_counts[w] += 1
        assigned_count += 1

        # Unlock dependents whose last remaining dependency was this point.
        for dep_id in dependents[pid]:
            remaining_deps[dep_id] -= 1
            if remaining_deps[dep_id] == 0:
                heapq.heappush(heap, (*priority_key(by_id[dep_id]), dep_id))

    if assigned_count != len(points):
        unassigned = [pt["id"] for pt in points if pt["id"] not in wave_assignment]
        print(
            f"WARNING: {len(unassigned)} point(s) could not be scheduled "
            f"(likely leftover cycle after break_cycles): {unassigned}"
        )

    return wave_assignment


def main():
    points = load_points()
    print(f"Loaded {len(points)} points total from {len(SOURCE_FILES)} source files.\n")

    points = validate_dependencies(points)
    print()
    points = break_cycles(points)
    print()

    wave_assignment = schedule_waves(points)

    by_id = {pt["id"]: pt for pt in points}
    max_wave = max(wave_assignment.values())
    num_waves = max_wave + 1

    # Build output sorted by wave then rank (1-indexed wave)
    output = [
        {"id": pid, "wave": wave_assignment[pid] + 1}
        for pid in wave_assignment
    ]
    output.sort(key=lambda r: (r["wave"], by_id[r["id"]]["rank"]))

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    # --- Summary ---
    print("=" * 60)
    print("SCHEDULE SUMMARY")
    print("=" * 60)
    print(f"Total points scheduled: {len(wave_assignment)}")
    print(f"Total waves: {num_waves}\n")

    per_wave_points = defaultdict(list)
    for pid, w in wave_assignment.items():
        per_wave_points[w].append(pid)

    for w in range(num_waves):
        ids_in_wave = per_wave_points[w]
        sev_counts = defaultdict(int)
        for pid in ids_in_wave:
            sev_counts[by_id[pid]["severity"]] += 1
        sev_str = ", ".join(
            f"{sev}={sev_counts[sev]}"
            for sev in ["Critical", "High", "Medium", "Low"]
            if sev_counts[sev]
        )
        print(f"Wave {w + 1}: {len(ids_in_wave)} points ({sev_str})")

    print(f"\nWrote {len(output)} assignments to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
