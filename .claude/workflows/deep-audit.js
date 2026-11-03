export const meta = {
  name: "deep-audit",
  description:
    "Hunt for >=1.5x (configurable) cost/latency/quality/scale/dev-loop levers and redesigns, plus inefficiencies, pain points and bugs; verify, fix in parallel, review, re-audit until clean, report",
  whenToUse:
    "Run through the deep-audit skill. Long, multi-agent: maps the repo, finds and verifies issues, fixes them on branches, reviews each fix, integrates, and loops until nothing material is left.",
  phases: [
    { title: "Map", detail: "one agent maps areas, entry points, and how to measure" },
    {
      title: "Find",
      detail:
        "ambitious finders (>=1.5x by default) (cost, latency, quality, scale, dev loop, moonshot) plus inefficiency, pain points, bugs",
    },
    { title: "Dedup", detail: "merge duplicate findings across dimensions" },
    { title: "Verify", detail: "two skeptics per finding with different lenses" },
    { title: "Audit", detail: "write the audit report and split it into work packages with disjoint files" },
    { title: "Fix", detail: "one fixer per package in its own worktree; reviewer loop until approved" },
    { title: "Integrate", detail: "merge approved branches into one integration branch and run the full checks" },
    { title: "Report", detail: "plain-language summary of what was found, fixed and left" },
  ],
};

// ── Arguments (all optional) ──────────────────────────────────────────────────────────────────────────────────────
// scope:        what to audit ("the whole repo", or paths / packages)            default: whole repo
// focus:        extra emphasis from the user ("cost of the reader", "the HTTP API")  default: none
// date:         YYYY-MM-DD for file and branch names (scripts cannot read the clock) default: "undated"
// maxRounds:    audit → fix → re-audit rounds                                     default: 3
// maxFindings:  verified findings fixed per round (highest value first)           default: 24
// maxPackages:  work packages per round                                           default: 10
// fixAttempts:  fixer ↔ reviewer attempts per package                            default: 3
// allowSpend:   may agents make paid model/API calls to measure (true only if the user said so) default: false
// spendNote:    the user's budget and how to meter it, passed to every agent      default: none
// reviewerAgent: a custom subagent type for reviews (e.g. "reviewer")             default: built-in agent
// baseBranch:   branch the work starts from                                       default: "main"
// auditPath:    where the audit report is written      default: docs/audits/<date>-deep-audit.md
const A = args || {};
const SCOPE = A.scope || "the whole repository";
const FOCUS = A.focus ? `\nUser's extra focus: ${A.focus}` : "";
const DATE = A.date || "undated";
const MAX_ROUNDS = A.maxRounds || 3;
// The smallest improvement a lever finder keeps (a multiple of the metric); `minMultiple` in args.
const MIN = A.minMultiple || 1.5;
const MAX_FINDINGS = A.maxFindings || 24;
const MAX_PACKAGES = A.maxPackages || 10;
const FIX_ATTEMPTS = A.fixAttempts || 3;
const BASE = A.baseBranch || "main";
const AUDIT_PATH = A.auditPath || `docs/audits/${DATE}-deep-audit.md`;
const INTEGRATION = `audit/${DATE}-integration`;
const SPEND = A.allowSpend
  ? `You MAY make paid model/API calls to measure, within this budget and metering: ${A.spendNote || "keep it minimal and report every cent"}.`
  : "Do NOT make any paid model or API calls. Measure with local, no-model commands only; label any number you could not measure as an estimate.";

const RULES = `
Ground rules for every agent:
- Follow the repository's CLAUDE.md files and decision log; where a rule and this task conflict, the rule wins and you say so.
- Honest numbers only: every number you report comes from a command you ran (say which) or is labelled an estimate with its arithmetic.
- ${SPEND}
- Never print secrets or API keys. Never weaken a security, privacy or isolation check to make something pass. Never skip, disable or delete a test to get green.
- Cite evidence as file:line. Be ruthless and concrete; no generic advice.`;

// Agents that run without their own worktree share the user's checkout: they must not change it.
const READONLY = `
- You share the user's checkout: do NOT commit, switch branches, stash, reset or leave changed files behind. Write any
  scratch script or output under a temporary directory and delete it when done. Report findings; do not fix them.`;

// Several worktrees exist at once and git refuses to check out a branch that another worktree holds. So agents never
// check out a shared branch: they work on a detached HEAD and publish with an explicit ref update.
const GITREFS = (branch, from) => `
Git, exactly like this (other agents hold other worktrees at the same time):
- Start: \`git checkout --detach ${from}\` (never \`git checkout <branch>\` on a shared branch; it fails if another worktree
  holds it).
- Commit your work on the detached HEAD.
- Publish: \`git update-ref refs/heads/${branch} HEAD\` (create or move the branch to your commit). If the branch already
  existed, first make sure your HEAD contains its old tip (\`git merge-base --is-ancestor <old> HEAD\`); never drop
  someone else's commits.
- Report the commit sha you published.`;

const SEVERITY = { type: "string", enum: ["critical", "high", "medium", "low"] };
const FINDING = {
  type: "object",
  properties: {
    id: { type: "string", description: "short stable slug, e.g. sec-redact-logs" },
    dimension: {
      type: "string",
      enum: ["cost", "latency", "quality", "scale", "devloop", "moonshot", "inefficiency", "painpoint", "correctness"],
    },
    title: { type: "string" },
    severity: SEVERITY,
    files: { type: "array", items: { type: "string" } },
    evidence: { type: "string", description: "file:line references and measured numbers, with the commands run" },
    impact: { type: "string", description: "quantified effect on cost / speed / quality / risk, with arithmetic" },
    fix: { type: "string", description: "concrete plan: what changes where, and how to prove it worked" },
    effort: { type: "string", enum: ["S", "M", "L"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["id", "dimension", "title", "severity", "files", "evidence", "impact", "fix", "effort", "confidence"],
};
const FINDINGS = {
  type: "object",
  properties: { findings: { type: "array", items: FINDING } },
  required: ["findings"],
};
const VERDICT = {
  type: "object",
  properties: {
    real: { type: "boolean", description: "true only if the evidence holds up and the fix plan is sound" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    severity: SEVERITY,
    correctedImpact: { type: "string" },
    notes: { type: "string" },
  },
  required: ["real", "confidence", "severity", "notes"],
};
const PACKAGES = {
  type: "object",
  properties: {
    auditPath: { type: "string" },
    packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "slug, used in the branch name" },
          title: { type: "string" },
          findingIds: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          plan: { type: "string" },
          acceptance: { type: "array", items: { type: "string" }, description: "checks a reviewer can run" },
        },
        required: ["id", "title", "findingIds", "files", "plan", "acceptance"],
      },
    },
    deferred: { type: "array", items: { type: "string" }, description: "finding ids not packaged this round, and why" },
  },
  required: ["auditPath", "packages", "deferred"],
};
const FIXED = {
  type: "object",
  properties: {
    branch: { type: "string" },
    commit: { type: "string" },
    summary: { type: "string" },
    checks: { type: "string", description: "commands run and their results" },
    measured: { type: "string", description: "before/after numbers for the claimed impact" },
    blocked: {
      type: "string",
      description: "EMPTY when you produced a fix. Non-empty ONLY if you could not produce any fix at all, and why.",
    },
    notes: { type: "string", description: "anything else the reviewer should know (caveats, follow-ups)" },
  },
  required: ["branch", "commit", "summary", "checks", "measured", "blocked", "notes"],
};
const REVIEW = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    resolved: { type: "array", items: { type: "string" }, description: "finding ids genuinely resolved" },
    issues: { type: "array", items: { type: "string" }, description: "what must change, concretely" },
    notes: { type: "string" },
  },
  required: ["approved", "resolved", "issues", "notes"],
};
const MERGED = {
  type: "object",
  properties: {
    branch: { type: "string" },
    merged: { type: "array", items: { type: "string" } },
    conflictsResolved: { type: "array", items: { type: "string" } },
    dropped: { type: "array", items: { type: "string" }, description: "branches not merged, with why" },
    checks: { type: "string" },
    green: { type: "boolean" },
  },
  required: ["branch", "merged", "conflictsResolved", "dropped", "checks", "green"],
};

// Shared instructions for the ambitious finders: breadth first, then ruthless arithmetic.
const LEVER = (metric) => `
Target: improvements of AT LEAST ${MIN}x on ${metric} (bigger multiples rank higher; 10x or more highest). Be creative
and ambitious: first write down at least 12 candidate ideas, including unconventional ones (a different architecture,
removing the work entirely, precomputing or caching it, batching, moving it off the critical path, speculation,
approximation with a measured error, a different algorithm or data structure, a cheaper or smaller model or no model,
learned components trained offline, sharing work across users or sessions where isolation allows, changing what is
measured or delivered). Then measure the current baseline, do the arithmetic for each idea from measured numbers, and
keep only ideas that plausibly reach >=${MIN}x on the metric or on a sub-part that dominates it. Say plainly where even
${MIN}x is impossible and why. Severity: "critical" for >=10x, "high" for 3-10x, "medium" for ${MIN}-3x; anything below
${MIN}x is "low" unless it unblocks a bigger lever. The fix may be a large structural change: give a staged plan whose
first stage can be built and measured by one agent.`;

const DIMENSIONS = [
  {
    key: "cost",
    prompt: `Find ways to cut the product's running cost per task and per user (model/API calls and tokens, connector
calls, storage, compute) by at least ${MIN}x.${LEVER("cost per task and per user, at equal or better quality")}`,
  },
  {
    key: "latency",
    prompt: `Find ways to cut latency the user or the integrating agent waits for (critical-path time, end-to-end task
time, p50 and p90) by at least ${MIN}x.${LEVER("critical-path latency and task wall time, at equal or better quality")}`,
  },
  {
    key: "quality",
    prompt: `Find ways to make the product markedly better at its own success metrics (read the evals and benchmarks to
learn them), e.g. cutting the miss rate or the false-alarm rate by at least ${MIN}x.${LEVER("the error rate on the product's main quality metrics, at bounded cost")}`,
  },
  {
    key: "scale",
    prompt: `Find ways to raise how much the system handles per machine (memory and CPU per user and per item,
throughput, startup and sync/ingest time, behaviour on accounts 10-100x larger than the test worlds) by at least
${MIN}x.${LEVER("memory per user, throughput and ingest time")}`,
  },
  {
    key: "devloop",
    prompt: `Find ways to make working on this repo at least ${MIN}x faster or cheaper: check and test time, benchmark and
experiment time and cost, time to answer "did my change help?".${LEVER("developer and experiment cycle time and cost")}`,
  },
  {
    key: "moonshot",
    prompt: `Step back from the current design. If you were rebuilding this product from first principles with what the
repo's research has learned (read docs/research and the decision log), what would you build differently, and which
parts of that could be built now as an experiment behind a flag? Propose at most 4 bold redesigns, each with the
measured evidence that motivates it and a first experiment.${LEVER("cost, latency and quality together")}`,
  },
  {
    key: "inefficiency",
    prompt: `Find inefficiencies: wasted work on hot paths, redundant model or API calls, cacheable prompts laid out so they cannot cache, oversized prompts/outputs, N+1 calls, unbounded growth, dead flags and dead code paths, duplicated subsystems, slow tests and slow dev loops (time the test suite and its slowest files), scripts that make common work slow. Quantify each with measurements.`,
  },
  {
    key: "painpoint",
    prompt: `Find pain points for every kind of user: (1) an integrator adopting the product (SDK/API ergonomics, defaults that silently degrade results, confusing errors, missing docs/examples, setup friction); (2) the end user (wrong or noisy output, latency they feel, surprising behaviour); (3) a developer working on this repo (unclear structure, missing docs, fragile scripts, hard-to-run benchmarks). Walk through each journey concretely (run the example/setup/commands yourself) and report where it breaks or hurts, with evidence.`,
  },
  {
    key: "correctness",
    prompt: `Find correctness bugs: logic errors, edge cases (empty, huge, unicode, time zones, concurrency, retries), broken invariants, tests that pass without testing the behaviour, docs that contradict code. Reproduce each with a failing test or a command.`,
  },
];

const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
const effortRank = { S: 0, M: 1, L: 2 };
const byValue = (a, b) => sevRank[a.severity] - sevRank[b.severity] || effortRank[a.effort] - effortRank[b.effort];

// ── Map ───────────────────────────────────────────────────────────────────────────────────────────────────────────
phase("Map");
const map = await agent(
  `Map ${SCOPE} for an audit.${FOCUS}
Read the root and per-directory CLAUDE.md files, the docs index, the package layout, and the main entry points. Find:
the hot paths (what runs per request/event), how the product is measured (benchmarks, evals, their commands and cost),
the test and check commands and how long they take (run them), and any recent measurements in docs. Return a compact
brief (≤ 1,500 words) another agent can use as its only orientation: areas with paths, hot paths, how to measure, how to
check, rules that constrain changes, and known open problems.${RULES}${READONLY}`,
  { label: "map", phase: "Map" },
);

const seen = new Set();
const ledger = { found: [], verified: [], rejected: [], resolved: [], unresolved: [], packages: [], merges: [] };
let round = 0;

while (round < MAX_ROUNDS) {
  round++;
  const roundNote =
    round === 1
      ? ""
      : `\nThis is re-audit round ${round}: focus on code changed by the previous rounds on branch ${INTEGRATION} and on anything still unresolved; do not repeat known findings: ${[...seen].join(", ")}.`;

  // ── Find: one finder per dimension, in parallel; a barrier is needed to dedup across dimensions ──
  phase("Find");
  const raw = (
    await parallel(
      DIMENSIONS.map(
        (d) => () =>
          agent(
            `${d.prompt}\n\nScope: ${SCOPE}.${FOCUS}${roundNote}\n\nOrientation brief:\n${map}\n${RULES}${READONLY}\nReturn at most 12 findings, most valuable first (biggest measured multiple first).`,
            { label: `find:${d.key}:r${round}`, phase: "Find", schema: FINDINGS },
          ),
      ),
    )
  )
    .filter(Boolean)
    .flatMap((r) => r.findings)
    .filter((f) => !seen.has(f.id));
  log(`round ${round}: ${raw.length} raw findings`);
  if (!raw.length) break;

  phase("Dedup");
  const deduped = await agent(
    `Merge duplicates in these audit findings (same root cause or same fix → one finding; keep the strongest evidence and
the highest justified severity; keep ids stable where possible). Drop any finding without file:line evidence. Return the
merged list.${READONLY}\n\n${JSON.stringify(raw)}`,
    { label: `dedup:r${round}`, phase: "Dedup", schema: FINDINGS },
  );
  const candidates = (deduped ? deduped.findings : raw).filter((f) => !seen.has(f.id)).sort(byValue);
  candidates.forEach((f) => seen.add(f.id));
  ledger.found.push(...candidates);
  const toVerify = candidates.slice(0, MAX_FINDINGS * 2);
  if (candidates.length > toVerify.length)
    log(
      `round ${round}: verifying the top ${toVerify.length} of ${candidates.length}; the rest are listed as unverified`,
    );

  // ── Verify: two skeptics per finding, different lenses ──
  phase("Verify");
  const verified = (
    await parallel(
      toVerify.map(
        (f) => () =>
          parallel(
            [
              "Does the evidence hold? Re-read the cited code and re-run any cited command. Default to real=false if you cannot reproduce it.",
              "Is the impact estimate sound and is the fix right (and not harmful)? Recompute the arithmetic from measured numbers, including whether the claimed multiple really holds and is at least the target; check the fix against the repo rules. Default to real=false if the fix would not deliver the claimed effect.",
            ].map(
              (lens, i) => () =>
                agent(
                  `Adversarially verify this audit finding. ${lens}\n\nFinding:\n${JSON.stringify(f)}\n${RULES}${READONLY}`,
                  {
                    label: `verify:${f.id}:${i}`,
                    phase: "Verify",
                    schema: VERDICT,
                  },
                ),
            ),
          ).then((vs) => {
            const ok = vs.filter(Boolean);
            const yes = ok.filter((v) => v.real);
            const hardNo = ok.some((v) => !v.real && v.confidence === "high");
            const keep = yes.length === 2 || (yes.length === 1 && !hardNo);
            const sev = yes.length ? yes.map((v) => v.severity).sort((a, b) => sevRank[b] - sevRank[a])[0] : f.severity;
            return { f: { ...f, severity: sev, verification: ok.map((v) => v.notes) }, keep };
          }),
      ),
    )
  ).filter(Boolean);
  const kept = verified
    .filter((v) => v.keep)
    .map((v) => v.f)
    .sort(byValue);
  ledger.verified.push(...kept);
  ledger.rejected.push(...verified.filter((v) => !v.keep).map((v) => v.f));
  log(`round ${round}: ${kept.length} verified, ${verified.length - kept.length} rejected`);
  const material = kept.filter((f) => f.severity !== "low");
  if (!material.length) {
    log(`round ${round}: nothing material left; stopping`);
    break;
  }
  const work = kept.slice(0, MAX_FINDINGS);
  if (kept.length > work.length)
    log(`round ${round}: fixing the top ${work.length} of ${kept.length} verified findings`);

  // ── Audit report and work packages with disjoint file sets ──
  phase("Audit");
  const audit = await agent(
    `Write (or extend, if it exists) the audit report at ${AUDIT_PATH}: a plain-language summary at the top, then the
verified findings ranked by value (severity, then effort), each with evidence, impact, fix and status. Add a round ${round}
section. Then split the findings into at most ${MAX_PACKAGES} work packages for parallel fixers: packages must not share
files (merge or sequence them otherwise), each package small enough for one agent, with concrete acceptance checks a
reviewer can run. Defer findings that need a decision from the user (say what decision). Commit the report and publish it to
${INTEGRATION} as described below.\n\nVerified findings:\n${JSON.stringify(work)}\n${RULES}\n${GITREFS(INTEGRATION, `${INTEGRATION} if it exists, else ${BASE}`)}`,
    { label: `audit:r${round}`, phase: "Audit", schema: PACKAGES, isolation: "worktree" },
  );
  if (!audit || !audit.packages.length) break;
  ledger.packages.push(...audit.packages);

  // ── Fix → review loop per package, pipelined (no barrier between packages) ──
  phase("Fix");
  const fixes = await pipeline(audit.packages, async (pkg) => {
    const findings = work.filter((f) => pkg.findingIds.includes(f.id));
    const branch = `audit/${DATE}-r${round}-${pkg.id}`;
    let issues = [];
    let last = null;
    for (let attempt = 1; attempt <= FIX_ATTEMPTS; attempt++) {
      const fixed = await agent(
        `Fix this work package completely. Your branch is ${branch}${attempt > 1 ? " (it already holds your previous attempt; continue from it)" : ` (new, from ${INTEGRATION})`}.
Tests first for behaviour changes; measure before and after for any claimed performance, cost or quality effect; run
the repo's checks; commit (no push needed unless the repo requires it). Touch only these files unless unavoidable (say
why): ${pkg.files.join(", ")}.
${issues.length ? `\nThe reviewer rejected the previous attempt. Fix every one of these:\n- ${issues.join("\n- ")}` : ""}

Package: ${JSON.stringify(pkg)}\nFindings: ${JSON.stringify(findings)}\nOrientation brief:\n${map}\n${RULES}\n${GITREFS(branch, attempt > 1 ? branch : INTEGRATION)}\nAn independent reviewer agent runs after you: do not try to start one; just leave the branch ready for review.`,
        { label: `fix:${pkg.id}:${attempt}`, phase: "Fix", isolation: "worktree", schema: FIXED },
      );
      if (!fixed || fixed.blocked)
        return { pkg, approved: false, fixed, review: null, why: fixed ? fixed.blocked : "fixer died" };
      const review = await agent(
        `Review branch ${fixed.branch} (diff against ${INTEGRATION}) as an independent, adversarial reviewer. Assume defects
until shown otherwise. Check each acceptance item yourself, re-run the checks and any measurement the fixer claims, look
for regressions, weakened security, skipped tests, and side effects outside the package's files. Approve only if every
finding below is genuinely resolved.\n\nPackage: ${JSON.stringify(pkg)}\nFindings: ${JSON.stringify(findings)}\nFixer's report: ${JSON.stringify(fixed)}\n${RULES}\nWork in your own worktree: run \`git checkout --detach ${fixed.branch}\`, then run the checks there. Do not commit.`,
        {
          label: `review:${pkg.id}:${attempt}`,
          isolation: "worktree",
          phase: "Fix",
          schema: REVIEW,
          ...(A.reviewerAgent ? { agentType: A.reviewerAgent } : {}),
        },
      );
      last = { pkg, fixed, review };
      if (review && review.approved) return { ...last, approved: true };
      issues = review ? review.issues : ["reviewer died; re-verify the work yourself and report checks in full"];
    }
    return { ...(last || { pkg }), approved: false, why: `not approved after ${FIX_ATTEMPTS} attempts` };
  });
  const done = fixes.filter(Boolean);
  const approved = done.filter((d) => d.approved);
  for (const d of done) {
    const ids = d.pkg.findingIds;
    if (d.approved) ledger.resolved.push(...ids.filter((id) => (d.review.resolved || ids).includes(id)));
    else ledger.unresolved.push(...ids.map((id) => `${id} (${d.why || "rejected"})`));
  }
  log(`round ${round}: ${approved.length}/${done.length} packages approved`);
  if (!approved.length) break;

  // ── Integrate approved branches and run the full checks ──
  phase("Integrate");
  const merged = await agent(
    `Merge these approved branches into ${INTEGRATION} one at a time (a merge commit each; no history rewriting).
Resolve conflicts by keeping both packages' intent; if a conflict cannot be resolved safely, leave that branch out and
say why. After merging, run the repo's full checks and any evals/benchmarks the orientation brief names as no-cost.
Fix only integration breakage (not new features). Report what is green.\n\nBranches: ${JSON.stringify(approved.map((d) => d.fixed.branch))}\nOrientation brief:\n${map}\n${RULES}\n${GITREFS(INTEGRATION, INTEGRATION)}`,
    { label: `integrate:r${round}`, phase: "Integrate", schema: MERGED, isolation: "worktree" },
  );
  ledger.merges.push(merged);

  // Every fixer, reviewer and integrator gets a full checkout; a long run fills the disk unless finished ones go.
  await agent(
    `Free disk between rounds. List git worktrees (\`git worktree list --porcelain\`). Remove (\`git worktree remove\`)
only worktrees under the repo's .claude/worktrees folder whose HEAD is already contained in ${INTEGRATION}
(\`git merge-base --is-ancestor <head> ${INTEGRATION}\`) or whose branch name starts with audit/ and is merged into it,
and that have no uncommitted changes (\`git -C <path> status --porcelain\` empty). Never remove anything else, never
delete branches, never touch the user's main checkout. Then \`git worktree prune\`. Report what you removed and the
free disk (\`df -h .\`) before and after.`,
    { label: `cleanup:r${round}`, phase: "Integrate" },
  );
  if (!merged || !merged.green) {
    log(`round ${round}: integration not green; stopping so a human can look`);
    break;
  }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────────────────────────
phase("Report");
const report = await agent(
  `Write the final summary of a multi-round audit-and-fix run for a non-specialist owner of this repo, and append it to
the top of ${AUDIT_PATH} (commit and publish it to ${INTEGRATION} as described at the end). Make it legible: short sentences, plain words, no jargon
without a one-line explanation. Structure:
1. The bottom line in 3–5 sentences (what was wrong, what is fixed, what it changes for users/cost/speed/safety).
2. A table: dimension × (found, verified, fixed and reviewed, still open).
3. The most important fixes, each in one or two lines with measured before/after numbers (label estimates).
4. What is still open and why (needs a decision, too big, rejected by review), with the next step for each.
5. Where everything is: the audit file, the integration branch, per-package branches.
Use only facts from the data below; do not invent numbers. Check each claimed fix against git (is its branch merged in
${INTEGRATION}?) and say so where the data and git disagree.
${GITREFS(INTEGRATION, INTEGRATION)}\n\nData:\n${JSON.stringify({
    rounds: round,
    ledger: {
      found: ledger.found.map((f) => ({ id: f.id, dimension: f.dimension, severity: f.severity, title: f.title })),
      verified: ledger.verified.map((f) => ({
        id: f.id,
        dimension: f.dimension,
        severity: f.severity,
        title: f.title,
        impact: f.impact,
      })),
      rejected: ledger.rejected.map((f) => f.id),
      resolved: ledger.resolved,
      unresolved: ledger.unresolved,
      merges: ledger.merges,
    },
  })}`,
  { label: "report", phase: "Report", isolation: "worktree" },
);

return {
  rounds: round,
  integrationBranch: INTEGRATION,
  auditPath: AUDIT_PATH,
  counts: {
    found: ledger.found.length,
    verified: ledger.verified.length,
    rejected: ledger.rejected.length,
    resolved: ledger.resolved.length,
    unresolved: ledger.unresolved.length,
  },
  unresolved: ledger.unresolved,
  report,
};
