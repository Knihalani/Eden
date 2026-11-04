"""Adapts this repo's packages/engine/bench/ingest.bench.ts to the 18366d039 sync, in the BEFORE tree only.

The old SyncOptions needs `everyMs` (0: no timed polls) and the old sync has no `stats.backgroundItems`, so the
backfill is timed until the cache holds every item (a per-tick count over the users, a small overhead charged to the
BEFORE side), and the unchanged sweep is not measured. Run from the BEFORE tree's root (make-before-tree.sh does).
"""

PATH = "packages/engine/bench/ingest.bench.ts"

EDITS = [
    ("  maxItems: PER_USER,\n", "  maxItems: PER_USER,\n  everyMs: 0,\n"),
    ("const options: SyncOptions = {", "const options = {"),
    (
        "const sync = new SyncManager({ sources: async (scope) => [byUser.get(scope.userId)!], fanout, cache, now }, "
        "options);",
        "const sync = new SyncManager(\n"
        "  { sources: async (scope) => [byUser.get(scope.userId)!], fanout, cache, now },\n"
        "  options as unknown as SyncOptions,\n);",
    ),
    (
        "  const target = sync.stats.backgroundItems + items;\n"
        "  const t0 = performance.now();\n"
        "  for (let i = 0; sync.stats.backgroundItems < target; i++) {",
        "  const synced = () => users.reduce((n, { scope }) => n + cache.syncedCount(scope), 0);\n"
        "  const target = synced() + items;\n"
        "  const t0 = performance.now();\n"
        "  for (let i = 0; synced() < target; i++) {",
    ),
    (
        "clock += HOUR + 1;\n"
        "for (const { scope } of users) sync.track(scope, clock);\n"
        "const sweepMs = await listAll(USERS * PER_USER);",
        "// BEFORE tree: not measured (no listing counter in the 18366d039 sync to tell when a sweep is done).\n"
        "const sweepMs = NaN;",
    ),
]

text = open(PATH).read()
for old, new in EDITS:
    assert text.count(old) == 1, f"ingest.bench.ts changed: {old[:60]!r} not found once"
    text = text.replace(old, new, 1)
open(PATH, "w").write(text)
