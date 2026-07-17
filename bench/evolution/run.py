"""Evolution scorecard CLI — smoke | full suites."""

from __future__ import annotations

import argparse
import json
import sys

from bench.evolution.scorecard import run_scorecard


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evolution replay harness")
    parser.add_argument("--suite", choices=["smoke", "full"], default="smoke")
    args = parser.parse_args(argv)
    result = run_scorecard(args.suite)
    print(json.dumps(result, indent=2))
    if result.get("failed"):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
