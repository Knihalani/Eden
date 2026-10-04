/** The gate for the floor arms (A5 §4, correctness and safety): each state as `arms.json` records it. */
import { gate } from "./gate";

gate([
  "cross-session",
  "worktree",
  "spawn-writers",
  "reload-stale",
  "rewind",
  "negation",
  "numbered-list",
  "secrets",
  "migrate",
  "poison",
  "fail-open",
]);
