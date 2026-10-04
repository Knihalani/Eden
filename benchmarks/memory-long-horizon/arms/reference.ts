/**
 * The arms' references (prereg target 3): for every arm, what a plugin that does what A5 asks answers on the arm's
 * script, as a table for the scripted plugin in reference mode (harness/fixtures/scripted-plugin/answer.ts), plus the
 * reference CLI (fixtures/reference-cli.ts) for the entry points arms define. reference-suite.ts runs each arm with
 * them and expects no check to fail: so no arm is unsatisfiable, and a silent plugin (which fails the controls) is
 * not what passes them.
 *
 * Packets are worded the way A4 §5.8 shows ("Auth provider in apps/web: Clerk", "Rule you set: …"), so the oracle's
 * reader is exercised on the target wording, not on today's.
 */
import { join } from "node:path";
import { buildWorld } from "../../memory-scale/hard-world";
import { isNegative, memories, nimCues, perCategory, r1Cues, type BenchCue } from "./cuebench";
import { ciCases } from "./scale";

export interface Rule {
  event: string;
  when: string | string[];
  context?: string;
  decision?: "ask" | "allow" | "deny";
  reason?: string;
  once?: boolean;
  tag?: string;
  after?: string;
  log?: string;
}

export interface Reference {
  answers: Rule[];
  env?: Record<string, string>;
}

export const REFERENCE_CLI = ["bun", join(import.meta.dir, "fixtures", "reference-cli.ts")];

const HEADER = "Eden memory, recalled from earlier sessions:";
const packet = (...bullets: string[]) => [HEADER, ...bullets.map((bullet) => `- ${bullet}`)].join("\n");
const submit = (when: Rule["when"], ...bullets: string[]): Rule => ({
  event: "UserPromptSubmit",
  when,
  context: packet(...bullets),
});
const mark = (event: string, when: Rule["when"], tag: string): Rule => ({ event, when, tag });

const DATABASE = "Database: postgres (you said)";
const MERGE_RULE = "Rule you set: pull requests are merged by you, not by the agent";

/** The tables of the hook arms. */
const TABLES: Record<string, Reference> = {
  "cross-session": { answers: [submit("what database do we use?", DATABASE)] },
  worktree: { answers: [submit("what database do we use?", DATABASE)] },
  "reload-stale": { answers: [submit("which auth provider do we use?", "Auth provider: Clerk (you said)")] },
  "numbered-list": { answers: [submit("what database do we use?", DATABASE)] },
  negation: { answers: [{ ...submit("how should we cache sessions?", "Cache: Redis (you said)"), once: true }] },
  rewind: { answers: [submit("which auth provider do we use?", "Auth provider: Clerk (you said)")] },
  poison: { answers: [submit("what database do we use?", DATABASE)] },
  secrets: { answers: [submit("what database does staging use?", "The staging database is postgres (you said)")] },
  "fail-open": { answers: [] },
  scoped: {
    answers: [
      submit("how does this app authenticate", "apps/web: auth provider Clerk, database postgres"),
      submit("how does the cli authenticate", "packages/cli: no auth, database sqlite"),
    ],
    env: { SCRIPTED_EPISODES: "1" },
  },
  cascade: {
    answers: [
      submit("which node version should apps/web use?", "apps/web runs node 22"),
      submit("which node version should packages/cli use?", "packages/cli uses node 20, the repo default"),
      submit("which node version does the repo use by default?", "The repo uses node 20"),
    ],
  },
  "single-package": {
    answers: [
      submit("which database does src/db.ts talk to?", "Database: sqlite"),
      submit("which test runner do the tests in test/ use?", "Test runner: vitest"),
    ],
  },
  "fan-out": { answers: [submit("behave the same", "auth — apps/web: Clerk · packages/cli: none")] },
  nonhuman: { answers: [submit("what database do we use?", DATABASE)] },
  repeat: {
    answers: [
      mark("UserPromptSubmit", "We switched auth from Auth0 to Clerk.", "switched"),
      {
        ...submit("which auth provider do we use?", "Updated: auth provider is now Clerk (was Auth0)"),
        after: "switched",
        once: true,
      },
      { ...submit("which auth provider do we use?", "Auth provider: Auth0 (you said)"), once: true },
    ],
  },
  compaction: {
    answers: [
      { ...submit("what database do we use?", DATABASE), once: true },
      submit("merge the PRs once CI passes", MERGE_RULE),
    ],
  },
  resume: { answers: [submit("what database do we use?", DATABASE)] },
  subagent: {
    answers: [
      {
        event: "SubagentStart",
        when: "fix the redirect in apps/web/app/login.ts",
        context: packet("Auth provider in apps/web: Clerk"),
      },
      submit("how does this package authenticate?", "Auth in packages/cli: none"),
      {
        event: "SubagentStart",
        when: "look at apps/web/app/login.ts",
        context: packet("Auth provider in apps/web: Clerk"),
      },
      {
        event: "SubagentStart",
        when: "look at packages/cli/src/index.ts",
        context: packet("Auth in packages/cli: none"),
      },
    ],
  },
  "first-touch": {
    answers: [
      {
        event: "PostToolBatch",
        when: "packages/cli/src/index.ts",
        context: packet("Auth in packages/cli: none", "Database in packages/cli: sqlite"),
      },
    ],
  },
  residual: { answers: [submit("fix the auth redirect", "Auth provider: Clerk (you said)")] },
  shadow: { answers: [submit("what database do we use?", DATABASE)] },
  continue: {
    answers: [
      submit("which test environment does vitest.config use?", "vitest.config sets the test environment to jsdom"),
    ],
  },
  budget: {
    answers: [
      { ...submit("fix the auth check", "Auth provider: Clerk (you said)"), once: true },
      { ...submit("speed up the database query", DATABASE), once: true },
      { ...submit("the cache misses too often", "Cache: Redis (you said)"), once: true },
      { ...submit("bump the node version", "The repo uses node 20 (you said)"), once: true },
      { ...submit("make the vitest run faster", "Test runner: vitest (you said)"), once: true },
    ],
  },
  "re-eligibility": {
    answers: [submit("merge the PRs when CI is green", MERGE_RULE), submit("merge the PRs once CI passes", MERGE_RULE)],
  },
  "policy-guard": {
    answers: [
      {
        event: "PreToolUse",
        when: "gh pr merge 42 --squash",
        decision: "ask",
        reason: "Eden: rule you set (1 day ago): don't merge PRs yourself",
        context:
          "Rule you set (1 day ago): don't merge PRs yourself; pull requests are merged by you, not by the agent.",
      },
    ],
  },
  "guard-modes": {
    answers: (["dontAsk", "bypassPermissions"] as const)
      .map((mode): Rule => ({
        event: "PreToolUse",
        when: ["gh pr merge 42 --squash", `"permission_mode":"${mode}"`],
        context: `${MERGE_RULE}.`,
        log: "guard_bypassed",
      }))
      .concat({
        event: "PreToolUse",
        when: "gh pr merge 42 --squash",
        decision: "ask",
        reason: "Eden: rule you set: don't merge PRs yourself",
        context: `${MERGE_RULE}.`,
      }),
  },
  "guard-dedup": {
    answers: [
      { event: "PreToolUse", when: "git push --force origin feature", context: "Rule you set: never force-push." },
    ],
  },
  "policy-recur": {
    answers: [
      mark("UserPromptSubmit", ["Don't merge PRs yourself.", "repo-a"], "a"),
      mark("UserPromptSubmit", ["Don't merge PRs yourself.", "repo-b"], "b"),
      mark("UserPromptSubmit", "yes, everywhere", "confirmed"),
      { event: "SessionStart", when: "repo-a", after: "a×2", context: packet(MERGE_RULE) },
      {
        event: "SessionStart",
        when: "repo-b",
        after: "b×2",
        context: packet(`Proposed for all projects: ${MERGE_RULE} (say "yes, everywhere" to keep)`),
      },
      { event: "SessionStart", when: "repo-c", after: "confirmed", context: packet(`${MERGE_RULE} (all projects)`) },
    ],
  },
  "intent-expiry": {
    answers: [
      mark("UserPromptSubmit", "Open it now.", "released"),
      { event: "PreToolUse", when: ['gh pr create --fill"', "/released"], after: "released" },
      {
        event: "PreToolUse",
        when: ['gh pr create --fill"', "/released"],
        decision: "ask",
        reason: "Eden: intent you set: don't open the PR yet",
        context: "Intent you set: don't open the PR yet.",
      },
    ],
  },
  "repo-facts": {
    answers: [
      mark("UserPromptSubmit", "Use bun as the package manager here.", "bun"),
      { ...submit("install the dependencies", "Package manager: bun (you said)"), after: "bun" },
      {
        ...submit("install the dependencies", "Package manager: pnpm (cited: pnpm-lock.yaml)"),
        after: "npm",
        once: true,
      },
      {
        ...submit("install the dependencies", "Package manager: npm (cited: package-lock.json)"),
        once: true,
        tag: "npm",
      },
    ],
  },
  citation: {
    answers: [
      submit(
        "which auth provider does apps/web use?",
        "Auth provider in apps/web: Clerk (cited: apps/web/package.json)",
      ),
    ],
  },
  gotcha: {
    answers: [
      mark("PostToolUse", "42 pass, 0 fail", "fixed"),
      {
        event: "PostToolUseFailure",
        when: "ERR_REQUIRE_ESM",
        after: "fixed",
        context: packet('Earlier fix for "ERR_REQUIRE_ESM" here: vitest.config.ts renamed to vitest.config.mts'),
      },
    ],
  },
  migrate: {
    answers: [
      submit("what database do we use?", "Database: postgres (from an earlier session)"),
      submit("which auth provider do we use?", "Auth provider: Clerk (from an earlier session)"),
    ],
  },
  "stale-episode": { answers: [submit("how do I set up the cli db?", "Database in packages/cli: sqlite")] },
  "restate-learn": {
    answers: [
      mark("UserPromptSubmit", "Remember, deploys go through shipit.", "restated"),
      { ...submit("how do I push this to production?", "Deploys go through shipit (you said)"), after: "restated×2" },
    ],
  },
  continuation: { answers: [submit("yes do it", "vitest.config sets the test environment to jsdom")] },
};

/** CueBench-style arms: each positive cue is answered with its gold memories, each negative with nothing. */
function benchTable(cues: readonly BenchCue[]): Reference {
  const byId = new Map(memories().map((memory) => [memory.id, memory.text]));
  const answers = cues
    .filter((cue) => !isNegative(cue))
    .map((cue) => submit(JSON.stringify(cue.cue).slice(1, -1), ...cue.gold.map((id) => byId.get(id)!)));
  return { answers };
}

/** The cues the bench arms ask at CI scale (the same subsets as bench.ts). */
function ciCues(): BenchCue[] {
  const test = r1Cues().filter((cue) => cue.split === "test");
  return [
    ...perCategory(test, 3),
    ...perCategory(nimCues(), 3),
    ...perCategory(
      test.filter((cue) => cue.cat === "policy"),
      5,
    ),
    ...perCategory(
      test.filter((cue) => !isNegative(cue) && cue.cat !== "policy"),
      1,
    ),
    ...perCategory(
      nimCues().filter((cue) => cue.cat === "nim-policy"),
      3,
    ),
    ...perCategory(
      test.filter((cue) => !isNegative(cue)),
      2,
    ),
    ...perCategory(
      nimCues().filter((cue) => cue.cat === "nim-para"),
      3,
    ),
  ];
}

/** Scale arms: each case that needs slots is answered with the statements of their current values. */
function scaleTable(): Reference {
  const world = buildWorld(2_000);
  const answers = ciCases(world)
    .filter((item) => item.needs.length)
    .map((item) => {
      const said = item.needs.flatMap((slot) => {
        const current = world.current.get(slot);
        const statement = world.statements.findLast((s) => s.slot === slot && s.value === current);
        return statement ? [statement.text] : [];
      });
      return submit([JSON.stringify(item.cue).slice(1, -1), `/${item.repo}`], ...said);
    });
  return { answers };
}

/** The reference for an arm: its table (and environment). Driver-only arms need only the reference CLI. */
export function referenceFor(id: string): Reference {
  if (TABLES[id]) return TABLES[id]!;
  if (["cuebench-code", "policy-trigger", "alias-batch"].includes(id)) return benchTable(ciCues());
  if (id === "scale-20k" || id === "scale-1e6") return scaleTable();
  return { answers: [] };
}
