#!/usr/bin/env python3
"""Post a markdown summary of the most recent ``bench.run_all`` output
to ``$GITHUB_STEP_SUMMARY``.

Used by ``.github/workflows/perf-bench.yml``. Reads the most recent
``bench/results/*.json`` and emits a 3-column table (suite, p50, p95).
"""
from __future__ import annotations

import glob
import json
import os
from pathlib import Path


def main() -> int:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        print("GITHUB_STEP_SUMMARY not set; nothing to do")
        return 0

    files = sorted(glob.glob("bench/results/*.json"))
    if not files:
        with open(summary_path, "a") as f:
            f.write("\n## Perf Bench Summary\n\n_No benchmark results found._\n")
        return 0

    latest = files[-1]
    with open(latest) as f:
        data = json.load(f)

    lines = ["\n## Perf Bench Summary\n"]
    lines.append(f"Results file: `{Path(latest).name}`\n")
    lines.append("| Suite | p50 (ms) | p95 (ms) | Notes |")
    lines.append("|---|---|---|---|")
    for suite, results in data.get("suites", {}).items():
        if isinstance(results, list):
            for r in results:
                notes = ""
                if "error_rate" in r:
                    notes = f"err_rate={r['error_rate']}"
                elif "hit_rate" in r:
                    notes = f"hit_rate={r['hit_rate']}"
                lines.append(f"| {r['name']} | {r['p50_ms']} | {r['p95_ms']} | {notes} |")
        else:
            notes = ""
            if "error_rate" in results:
                notes = f"err_rate={results['error_rate']}"
            lines.append(
                f"| {results['name']} | {results['p50_ms']} | {results['p95_ms']} | {notes} |"
            )
    with open(summary_path, "a") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {len(lines) - 4} rows to {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
