/**
 * The policy arms (A5 §4, G1; D9, D11, D19, A4 §5.4, A6 §2.5): the PreToolUse guard asks before an action a live
 * rule forbids and says the same rule to Claude, per permission mode, with one response per command; rules recur
 * into pins and user-global proposals; intents ask until released or 7 days pass.
 *
 * `policy-recur` reads each of its clauses against its contrast: a rule said in one session is not a pin yet (D9),
 * and repo C does not have it before the proposal is confirmed (D11: user-global is never inferred).
 *
 * The guard's answers are read from the PreToolUse invocations: `permissionDecision`, its reason (shown to the
 * user only), and `additionalContext` (what Claude reads next to the tool result).
 */
import type { PermissionMode } from "../harness/payloads";
import type { Invocation } from "../harness/runner";
import type { SimWorld } from "../harness/session";
import { statementsIn } from "../harness/statements";
import {
  id,
  KEEP_FIXTURES,
  KEEP_OLD_API,
  monorepo,
  NO_FORCE_PUSH,
  NO_MERGE,
  NO_PR_YET,
  NO_PUSH,
  rule,
  SUBJECTS,
} from "./fixtures/world";
import { bash, check, DAY_MS, Driver, wideEvents, type Arm, type ArmRun } from "./kit";

/** The PreToolUse invocations for the first call of `command`. */
function guardOf(world: SimWorld, command: string): { toolUseId: string; calls: Invocation[] } | undefined {
  const record = world.log.find(
    (entry) =>
      entry.event === "PreToolUse" &&
      (entry.payload.tool_input as { command?: string } | undefined)?.command === command,
  );
  return record && { toolUseId: String(record.payload.tool_use_id), calls: record.invocations };
}

function decisions(world: SimWorld, command: string): string[] {
  return (guardOf(world, command)?.calls ?? []).flatMap((call) => call.outcome.permissionDecision ?? []);
}

function contexts(world: SimWorld, command: string): string[] {
  return (guardOf(world, command)?.calls ?? []).flatMap((call) => call.outcome.additionalContext ?? []);
}

/** Whether a text states that the rule `key` holds (statements.ts, with the arms' phrases). */
function statesRule(text: string, key: string): boolean {
  return statementsIn(text, SUBJECTS, [""]).some((statement) => statement.key === key);
}

const MERGE = "gh pr merge 42 --squash";
const MERGE_AGAIN = "gh pr merge 43 --squash";
const merge = (command: string) => bash(command, 0, "Merged pull request", [id(NO_MERGE, "")]);

const policyGuard: Arm = {
  id: "policy-guard",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec, { askAnswer: "decline" });
    const first = await Driver.start(world, spec);
    await first.say("Push the fix to the PR, but don't merge it yourself.", [rule(NO_MERGE, true)]);
    await first.end();
    world.advance(DAY_MS);
    const session = await Driver.start(world, spec);
    await session.turn("the PR is approved, wrap it up", { tools: [[merge(MERGE)]] });
    await session.say("You can merge PRs yourself now.", [rule(NO_MERGE, false)]);
    await session.turn("merge PR 43 too", { tools: [[bash(MERGE_AGAIN, 0, "Merged pull request")]] });
    await session.end();
    const asked = guardOf(world, MERGE);
    const reasons = (asked?.calls ?? []).flatMap((call) =>
      call.outcome.permissionDecision === "ask" ? [call.outcome.permissionDecisionReason ?? ""] : [],
    );
    const said = contexts(world, MERGE);
    const sameRule =
      reasons.some((reason) => statesRule(reason, NO_MERGE)) && said.some((text) => statesRule(text, NO_MERGE));
    const labelled =
      asked !== undefined &&
      wideEvents(world)
        .split("\n")
        .some((line) => line.includes(asked.toolUseId) && /declined/.test(line));
    return [
      check(
        "asks",
        decisions(world, MERGE).includes("ask"),
        `decisions on \`${MERGE}\`: ${decisions(world, MERGE).join(", ") || "none"}`,
      ),
      check(
        "context-matches-ask",
        sameRule,
        `ask reasons ${JSON.stringify(reasons)}; contexts ${JSON.stringify(said.map((t) => t.slice(0, 80)))}`,
      ),
      check(
        "no-ask-after-revoke",
        !decisions(world, MERGE_AGAIN).includes("ask"),
        `decisions after the revocation: ${decisions(world, MERGE_AGAIN).join(", ") || "none"}`,
      ),
      check("declined-label", labelled, `a wide event labels ${asked?.toolUseId ?? "the call"} declined: ${labelled}`),
    ];
  },
};

/** One guard case per permission mode (D19), each in a home of its own. */
async function guardIn(run: ArmRun, mode: PermissionMode): Promise<SimWorld> {
  const spec = monorepo();
  const world = run.world(spec, { permissionMode: mode, home: mode });
  const first = await Driver.start(world, spec);
  await first.say("Don't merge PRs yourself.", [rule(NO_MERGE, true)]);
  await first.end();
  world.advance(DAY_MS);
  const session = await Driver.start(world, spec);
  await session.turn("the PR is approved, wrap it up", { tools: [[merge(MERGE)]] });
  await session.end();
  return world;
}

const guardModes: Arm = {
  id: "guard-modes",
  flagged: true,
  async run(run) {
    const modes: PermissionMode[] = ["default", "auto", "dontAsk", "bypassPermissions"];
    const worlds = new Map<PermissionMode, SimWorld>();
    for (const mode of modes) worlds.set(mode, await guardIn(run, mode));
    const asks = (mode: PermissionMode) => decisions(worlds.get(mode)!, MERGE).includes("ask");
    const contextOnly = (mode: PermissionMode) =>
      contexts(worlds.get(mode)!, MERGE).some((text) => statesRule(text, NO_MERGE)) &&
      decisions(worlds.get(mode)!, MERGE).length === 0;
    const bypassLogged = (["dontAsk", "bypassPermissions"] as const).every((mode) =>
      /guard_bypassed/.test(wideEvents(worlds.get(mode)!)),
    );
    const denies = modes.filter((mode) => decisions(worlds.get(mode)!, MERGE).includes("deny"));
    const show = (mode: PermissionMode) => {
      const world = worlds.get(mode)!;
      const answered = decisions(world, MERGE).join(",") || "none";
      return `${mode}: decisions ${answered}, ${contexts(world, MERGE).length} contexts`;
    };
    return [
      check("ask-default", asks("default"), show("default")),
      check("ask-auto", asks("auto"), show("auto")),
      check("context-only-dontAsk", contextOnly("dontAsk"), show("dontAsk")),
      check("context-only-bypass", contextOnly("bypassPermissions"), show("bypassPermissions")),
      check(
        "bypass-logged",
        bypassLogged,
        `guard_bypassed in the wide events of dontAsk and bypassPermissions: ${bypassLogged}`,
      ),
      check("never-deny", denies.length === 0, `modes with a deny from the plugin: ${denies.join(", ") || "none"}`),
    ];
  },
};

const FORCE_PUSH = "git push --force origin feature";

const guardDedup: Arm = {
  id: "guard-dedup",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const first = await Driver.start(world, spec);
    await first.say("Never force-push.", [rule(NO_FORCE_PUSH, true)]);
    await first.say("Don't push without asking me.", [rule(NO_PUSH, true)]);
    await first.end();
    world.advance(DAY_MS);
    const session = await Driver.start(world, spec);
    await session.turn("push the branch", {
      tools: [[bash(FORCE_PUSH, 0, "", [id(NO_FORCE_PUSH, ""), id(NO_PUSH, "")])]],
    });
    await session.end();
    const responses = (guardOf(world, FORCE_PUSH)?.calls ?? []).filter(
      (call) => call.outcome.additionalContext !== undefined || call.outcome.permissionDecision !== undefined,
    );
    const text = responses.map((call) => call.outcome.additionalContext ?? call.outcome.permissionDecisionReason ?? "");
    return [
      check("one-response", responses.length === 1, `${responses.length} handlers answered \`${FORCE_PUSH}\``),
      check(
        "from-history-rewrite",
        responses.length === 1 && statesRule(text[0]!, NO_FORCE_PUSH),
        `the answer: ${JSON.stringify(text.map((t) => t.slice(0, 100)))}`,
      ),
    ];
  },
};

const PROPOSAL = /proposed for all projects/i;

/** The start of a packet's text, quoted, for a check's detail. */
const head = (text: string) => JSON.stringify(text.slice(0, 100));

const policyRecur: Arm = {
  id: "policy-recur",
  flagged: true,
  async run(run) {
    const repos = ["repo-a", "repo-b", "repo-c"].map((name) => {
      const spec = monorepo();
      return { spec, world: run.world(spec, { projectName: name }) };
    });
    const [a, b, c] = repos as [(typeof repos)[0], (typeof repos)[0], (typeof repos)[0]];
    const sleeps: (number | null)[] = [];
    const sleep = (world: SimWorld) => {
      world.advance(DAY_MS);
      sleeps.push(run.cli(world, ["sleep", "--idle", "--after", "0"]).exitCode);
    };
    const sessionSays = async (repo: typeof a, texts: [string, ReturnType<typeof rule>][]) => {
      repo.world.advance(DAY_MS);
      const session = await Driver.start(repo.world, repo.spec);
      for (const [text, effect] of texts) await session.say(text, [effect]);
      await session.end();
    };
    const startPacket = async (repo: typeof a): Promise<string> => {
      repo.world.advance(DAY_MS);
      const from = repo.world.log.length;
      const session = await Driver.start(repo.world, repo.spec);
      await session.end();
      return repo.world.deliveries
        .filter((delivery) => delivery.seq >= from && delivery.event === "SessionStart")
        .map((delivery) => delivery.content)
        .join("\n");
    };
    const noMerge: [string, ReturnType<typeof rule>] = ["Don't merge PRs yourself.", rule(NO_MERGE, true)];
    await sessionSays(a, [noMerge]);
    sleep(a.world);
    const afterOne = await startPacket(a);
    await sessionSays(a, [noMerge]);
    sleep(a.world);
    const pinned = await startPacket(a);
    for (let n = 0; n < 3; n++) await sessionSays(a, [["Don't open the PR yet.", rule(NO_PR_YET, true)]]);
    await sessionSays(a, [["Don't delete the fixtures.", rule(KEEP_FIXTURES, true)]]);
    sleep(a.world);
    const afterIntents = await startPacket(a);
    await sessionSays(b, [noMerge, ["Don't remove the old API.", rule(KEEP_OLD_API, true)]]);
    await sessionSays(b, [noMerge]);
    sleep(b.world);
    const proposed = await startPacket(b);
    const thirdBefore = await startPacket(c);
    const confirm = await Driver.start(b.world, b.spec);
    await confirm.turn("yes, everywhere");
    await confirm.end();
    sleep(c.world);
    const third = await startPacket(c);
    const packets = [afterOne, pinned, afterIntents, proposed, thirdBefore, third];
    const proposals = packets
      .join("\n")
      .split("\n")
      .filter((line) => PROPOSAL.test(line));
    const falseProposals = proposals.filter((line) => /fixtures|old api|delete|remove/i.test(line));
    return [
      check(
        "pin-after-2-sessions",
        !statesRule(afterOne, NO_MERGE) && statesRule(pinned, NO_MERGE),
        `repo A's SessionStart after 1 session: ${head(afterOne)}; after 2: ${head(pinned)}`,
      ),
      check(
        "intent-not-pinned",
        !statesRule(afterIntents, NO_PR_YET),
        `after 3 sessions of "not yet": ${JSON.stringify(afterIntents.slice(0, 160))}`,
      ),
      check(
        "proposal-shown",
        proposals.some((line) => statesRule(line, NO_MERGE)),
        `repo B's SessionStart: ${JSON.stringify(proposed.slice(0, 160))}; sleep exit codes ${sleeps.join(",")}`,
      ),
      check(
        "third-repo-gets-it",
        !statesRule(thirdBefore, NO_MERGE) && statesRule(third, NO_MERGE),
        `repo C before the confirmation: ${head(thirdBefore)}; after: ${head(third)}`,
      ),
      check(
        "no-false-proposal",
        falseProposals.length === 0,
        `proposals for unrelated objects: ${JSON.stringify(falseProposals)}`,
      ),
    ];
  },
};

const PR_CREATE = "gh pr create --fill";

const intentExpiry: Arm = {
  id: "intent-expiry",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const live = run.world(spec, { home: "released", projectName: "released" });
    const session = await Driver.start(live, spec);
    await session.say("Don't open the PR yet.", [rule(NO_PR_YET, true)]);
    await session.turn("open the PR", { tools: [[bash(PR_CREATE, 0, "", [id(NO_PR_YET, "")])]] });
    await session.say("Open it now.", [rule(NO_PR_YET, false)]);
    await session.turn("go ahead", { tools: [[bash(`${PR_CREATE} --draft`, 0, "")]] });
    await session.end();
    const stale = run.world(spec, { home: "expired", projectName: "expired" });
    const before = await Driver.start(stale, spec);
    await before.say("Don't open the PR yet.", [rule(NO_PR_YET, true)]);
    await before.end();
    stale.advance(8 * DAY_MS);
    const later = await Driver.start(stale, spec);
    await later.turn("open the PR", { tools: [[bash(PR_CREATE, 0, "")]] });
    await later.end();
    const show = (world: SimWorld, command: string) => decisions(world, command).join(", ") || "none";
    return [
      check("ask-while-live", decisions(live, PR_CREATE).includes("ask"), `while live: ${show(live, PR_CREATE)}`),
      check(
        "no-ask-after-release",
        !decisions(live, `${PR_CREATE} --draft`).includes("ask"),
        `after "open it now": ${show(live, `${PR_CREATE} --draft`)}`,
      ),
      check(
        "expired-after-7-days",
        !decisions(stale, PR_CREATE).includes("ask"),
        `8 days later: ${show(stale, PR_CREATE)}`,
      ),
    ];
  },
};

export const POLICY_ARMS: Arm[] = [policyGuard, guardModes, guardDedup, policyRecur, intentExpiry];
