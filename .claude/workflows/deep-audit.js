export const meta = {
  name: "deep-audit",
  description:
    "Audit the repo for order-of-magnitude cost/speed/quality levers, security, inefficiency and user pain points; verify, fix in parallel, review, re-audit until clean, report",
  whenToUse:
    "Run through the deep-audit skill. Long, multi-agent: maps the repo, finds and verifies issues, fixes them on branches, reviews each fix, integrates, and loops until nothing material is left.",
  phases: [
    { title: "Map", detail: "one agent maps areas, entry points, and how to measure" },
    { title: "Find", detail: "one finder per dimension (magnitude, security, inefficiency, pain points, correctness)" },
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

const SEVERITY = { type: "string", enum: ["critical", "high", "medium", "low"] };
const FINDING = {
  type: "object",
  properties: {
    id: { type: "string", description: "short stable slug, e.g. sec-redact-logs" },
    dimension: { type: "string", enum: ["magnitude", "security", "inefficiency", "painpoint", "correctness"] },
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
    blocked: { type: "string", description: "empty unless something stopped the fix" },
  },
  required: ["branch", "commit", "summary", "checks", "measured", "blocked"],
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

const DIMENSIONS = [
  {
    key: "magnitude",
    prompt: `Find ARCHITECTURAL and STRUCTURAL changes that would give order-of-magnitude (≥3–10×) improvements in cost, speed (latency and throughput) or quality (the product's own success metrics). Trace the hot paths end to end and measure each stage. Find what dominates cost and time (model calls, tokens, cache misses, waits on the critical path, duplicated work, data structures, memory per user/item, sync/ingest design). For each lever, do the arithmetic from measured numbers, and say plainly where an order of magnitude is impossible (e.g. a cost dominated by something the code cannot remove). Reject ideas that only sound good.`,
  },
  {
    key: "security",
    prompt: `Find security and privacy issues: secrets in code, logs or test output; injection (prompt injection via untrusted content, command/SQL/path injection); authn/authz and tenant/user isolation gaps; data sent to third parties beyond what docs promise; unredacted storage or logging; unsafe defaults; dependency risks; denial of service via unbounded input, loops or fan-out; error paths that leak data or fail closed where they must fail open (or the reverse). Prove each with a concrete path from an input to the failure; write a probe test where you can.`,
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
check, rules that constrain changes, and known open problems.${RULES}`,
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
            `${d.prompt}\n\nScope: ${SCOPE}.${FOCUS}${roundNote}\n\nOrientation brief:\n${map}\n${RULES}\nReturn at most 12 findings, most valuable first.`,
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
merged list.\n\n${JSON.stringify(raw)}`,
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
              "Is the impact estimate sound and is the fix right (and not harmful)? Recompute the arithmetic; check the fix against the repo rules. Default to real=false if the fix would not deliver the claimed effect.",
            ].map(
              (lens, i) => () =>
                agent(`Adversarially verify this audit finding. ${lens}\n\nFinding:\n${JSON.stringify(f)}\n${RULES}`, {
                  label: `verify:${f.id}:${i}`,
                  phase: "Verify",
                  schema: VERDICT,
                }),
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
reviewer can run. Defer findings that need a decision from the user (say what decision). Commit the report on branch
${INTEGRATION} (create it from ${BASE} if missing).\n\nVerified findings:\n${JSON.stringify(work)}\n${RULES}`,
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
        `Fix this work package completely. Work on git branch ${branch} (create it from ${INTEGRATION}${attempt > 1 ? "; it already exists — check it out and continue" : ""}).
Tests first for behaviour changes; measure before and after for any claimed performance, cost or quality effect; run
the repo's checks; commit (no push needed unless the repo requires it). Touch only these files unless unavoidable (say
why): ${pkg.files.join(", ")}.
${issues.length ? `\nThe reviewer rejected the previous attempt. Fix every one of these:\n- ${issues.join("\n- ")}` : ""}

Package: ${JSON.stringify(pkg)}\nFindings: ${JSON.stringify(findings)}\nOrientation brief:\n${map}\n${RULES}`,
        { label: `fix:${pkg.id}:${attempt}`, phase: "Fix", isolation: "worktree", schema: FIXED },
      );
      if (!fixed || fixed.blocked)
        return { pkg, approved: false, fixed, review: null, why: fixed ? fixed.blocked : "fixer died" };
      const review = await agent(
        `Review branch ${fixed.branch} (diff against ${INTEGRATION}) as an independent, adversarial reviewer. Assume defects
until shown otherwise. Check each acceptance item yourself, re-run the checks and any measurement the fixer claims, look
for regressions, weakened security, skipped tests, and side effects outside the package's files. Approve only if every
finding below is genuinely resolved.\n\nPackage: ${JSON.stringify(pkg)}\nFindings: ${JSON.stringify(findings)}\nFixer's report: ${JSON.stringify(fixed)}\n${RULES}`,
        {
          label: `review:${pkg.id}:${attempt}`,
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
Fix only integration breakage (not new features). Report what is green.\n\nBranches: ${JSON.stringify(approved.map((d) => d.fixed.branch))}\nOrientation brief:\n${map}\n${RULES}`,
    { label: `integrate:r${round}`, phase: "Integrate", schema: MERGED, isolation: "worktree" },
  );
  ledger.merges.push(merged);
  if (!merged || !merged.green) {
    log(`round ${round}: integration not green; stopping so a human can look`);
    break;
  }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────────────────────────
phase("Report");
const report = await agent(
  `Write the final summary of a multi-round audit-and-fix run for a non-specialist owner of this repo, and append it to
the top of ${AUDIT_PATH} on branch ${INTEGRATION} (commit). Make it legible: short sentences, plain words, no jargon
without a one-line explanation. Structure:
1. The bottom line in 3–5 sentences (what was wrong, what is fixed, what it changes for users/cost/speed/safety).
2. A table: dimension × (found, verified, fixed and reviewed, still open).
3. The most important fixes, each in one or two lines with measured before/after numbers (label estimates).
4. What is still open and why (needs a decision, too big, rejected by review), with the next step for each.
5. Where everything is: the audit file, the integration branch, per-package branches.
Use only facts from the data below; do not invent numbers.\n\nData:\n${JSON.stringify({
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
