/**
 * D11's user-global scope (A4 §1 `<root>/_user/`): the rules the user keeps for every repo, and the proposals that
 * lead to them.
 *
 * - **What it holds.** `policies.jsonl`: one line per rule kept for all projects, in the rule index's shape
 *   (`memory-rule-index.ts`) and tagged `all-projects`, so the guard, the Submit trigger and SessionStart read it
 *   beside a repo's own index. Policies only: never an intent, never a fact (D11: "never inferred from facts"). A
 *   repo row gives way to them: it loses the rules and clauses kept here, and goes when nothing is left
 *   (`withUserGlobal`), so one rule has one cid, `_user/P:…` (A4 §4).
 * - **How a rule gets there** (D11): a typed policy with an explicit phrase ("in all my projects", or "everywhere"
 *   and "globally" set off by a comma: `saysAllProjects`); `eden memory remember --global`; or a confirmed proposal.
 *   Callers pass text as the store keeps it (`storableText`: secrets redacted).
 * - **Proposals** (`proposals.jsonl`, append-only `propose`, `shown`, `next` and `keep` records): at sleep, a rule
 *   pinned in ≥ 2 repos (D9, `memory-pins.ts`), still in force in each, and neither kept nor proposed before, is
 *   proposed once. A SessionStart of a repo holding the pin shows it, once, in place of the pin's bullet: `Proposed for
 *   all projects: … (say "yes, everywhere" to keep)`. Only an answer to it keeps it: a typed "yes, everywhere" (an
 *   affirmative, as a sentence of its own; a bare "everywhere" answers many other questions) in the repo that showed
 *   it, in the session that showed it or that repo's next session, within 7 days. A proposal shown and not kept so is
 *   never shown again.
 * - **How a rule leaves:** a typed revocation or outright opposite (A4 §3.1, L8) said with D11's phrase ("…, in all my
 *   projects"), or "that rule is gone" after the guard asked about it, moves it to `history.jsonl`. Said without one,
 *   it holds in that repo only: each repo reads the rules kept here through its own validity, as it reads its rows.
 * - Files are written under `<file>.lock`, mode 0600; every read fails open to nothing.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { ulid } from "./memory-ids";
import { pinnedRules } from "./memory-pins";
import type { ProvenanceNote } from "./memory-provenance";
import {
  overturnable,
  overturnedKeys,
  ruleClause,
  ruleIdentity,
  ruleRefs,
  rulesIn,
  saysAllProjects,
  withoutRules,
  type Rule,
  type RuleRef,
} from "./memory-policy";
import { POLICIES_FILE, readRuleIndex, type IndexedRow } from "./memory-rule-index";
import { readInvalidations, rulesInForce } from "./memory-validity";

/** The user-global directory under the memory root, and the repo part of its cids (A4 §4). */
export const USER_GLOBAL = "_user";
/** The tag of a row kept for all projects: rendered `(all projects)` (D11). */
export const ALL_PROJECTS = "all-projects";

const PROPOSALS_FILE = "proposals.jsonl";
const HISTORY_FILE = "history.jsonl";

/** D11's answer to a proposal, as a sentence of its own. */
const KEEP_EVERYWHERE =
  /^(?:(?:yes|yep|yeah|sure|ok(?:ay)?)\b[\s,!.]*(?:keep it\s+)?everywhere|keep it everywhere)[\s.!]*$/i;
/** How long after it was shown a proposal may be answered (in its session or its repo's next one). */
const ANSWER_MS = 7 * 86_400_000;

export function userGlobalDir(root: string): string {
  return join(root, USER_GLOBAL);
}

export function isUserGlobal(row: { tags?: readonly string[] }): boolean {
  return (row.tags ?? []).includes(ALL_PROJECTS);
}

/** The rules kept for all projects (`policies.jsonl`). */
export function readUserRules(root: string): IndexedRow[] {
  return readRuleIndex(userGlobalDir(root));
}

/**
 * The rows a repo reads: the user-global ones first, then its own rows without the rules kept globally and their
 * clauses; a row left with no rule goes. A row with no D9 rule is kept as it is.
 */
export function withUserGlobal<T extends { text?: string; rules?: readonly RuleRef[] }>(
  own: readonly T[],
  global: readonly T[],
): T[] {
  const kept = new Set(global.flatMap((row) => (row.rules ?? []).map(ruleIdentity)));
  if (!kept.size) return [...global, ...own];
  const isKept = (rule: Rule) => ruleRefs([rule]).some((ref) => kept.has(ruleIdentity(ref)));
  const left = own.flatMap((row) => {
    if (!row.rules?.some((rule) => kept.has(ruleIdentity(rule)))) return [row];
    const rules = row.rules.filter((rule) => !kept.has(ruleIdentity(rule)));
    const text = withoutRules(String(row.text ?? ""), isKept).trim();
    return rules.length && text ? [{ ...row, text, rules }] : [];
  });
  return [...global, ...left];
}

/** A rule as its clause says it, with a capital first letter: "don't merge PRs yourself" of a longer prompt. */
function clauseOf(text: string, rule: RuleRef): string {
  const clause = ruleClause(text, ruleIdentity(rule)) ?? text.trim();
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/** A rule to keep: its text and the rule. Only the key, the narrowing and the action are kept, not a pin mark. */
export interface KeptRule {
  text: string;
  rule: RuleRef;
}

function keptRef({ k, c, v }: RuleRef): RuleRef {
  return { k, ...(c ? { c } : {}), ...(v ? { v } : {}) };
}

function ensureDir(root: string): string {
  const dir = userGlobalDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function appendLines(path: string, lines: readonly object[]): void {
  if (!lines.length) return;
  withFileLock(`${path}.lock`, () =>
    appendFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 }),
  );
}

/** Keeps rules for all projects (see the header); returns the identities newly kept. */
export function keepForAllProjects(root: string, rules: readonly KeptRule[], now: number): string[] {
  if (!rules.length) return [];
  const path = join(ensureDir(root), POLICIES_FILE);
  const added: string[] = [];
  withFileLock(`${path}.lock`, () => {
    const known = new Set(readUserRules(root).flatMap((row) => (row.rules ?? []).map(ruleIdentity)));
    const rows: IndexedRow[] = [];
    for (const { text, rule } of rules) {
      const identity = ruleIdentity(rule);
      if (known.has(identity) || rule.q !== undefined) continue;
      known.add(identity);
      added.push(identity);
      const tags = ["src:user", "pin", ALL_PROJECTS];
      rows.push({
        id: ulid(now),
        text: clauseOf(text, rule),
        kind: "constraint",
        at: now,
        tags,
        rules: [keptRef(rule)],
      });
    }
    if (rows.length) appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  });
  return added;
}

/** The policies a typed text keeps for all projects by D11's phrases: each sentence's policies, never an intent. */
export function rulesForAllProjects(typed: string): KeptRule[] {
  return String(typed ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter(saysAllProjects)
    .flatMap((sentence) =>
      ruleRefs(rulesIn(sentence).filter((rule) => rule.kind === "policy")).map((rule) => ({ text: sentence, rule })),
    );
}

/** Moves the rules kept for all projects with these identities to `history.jsonl` (see the header). */
export function dropUserRules(root: string, identities: readonly string[], now: number, why: string): string[] {
  const gone = new Set(identities);
  if (!gone.size) return [];
  const dir = userGlobalDir(root);
  const path = join(dir, POLICIES_FILE);
  let dropped: IndexedRow[] = [];
  try {
    withFileLock(`${path}.lock`, () => {
      const rows = readUserRules(root);
      dropped = rows.filter((row) => (row.rules ?? []).every((rule) => gone.has(ruleIdentity(rule))));
      if (!dropped.length) return;
      const left = rows.filter((row) => !dropped.includes(row));
      writeFileAtomic(path, left.map((row) => `${JSON.stringify(row)}\n`).join(""), 0o600);
    });
  } catch {
    return [];
  }
  appendLines(
    join(dir, HISTORY_FILE),
    dropped.map((row) => ({ ...row, invalid_at: now, why })),
  );
  return dropped.flatMap((row) => (row.rules ?? []).map(ruleIdentity));
}

/**
 * The rules kept for all projects that a typed sentence with D11's phrase overturns (A4 §3.1, L8), moved to history.
 * Without the phrase an overturning holds in its repo only (see the header).
 */
export function overturnUserRules(root: string, typed: string, now: number): string[] {
  const overturned = String(typed ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter(saysAllProjects)
    .flatMap((sentence) => overturnedKeys(sentence));
  if (!overturned.length) return [];
  const kept = readUserRules(root).flatMap((row) => row.rules ?? []);
  const due = kept.filter((rule) => overturned.includes(ruleIdentity(rule)) && overturnable(rule));
  return dropUserRules(root, due.map(ruleIdentity), now, "overturned");
}

/** A proposal (see the header), folded from its records. */
export interface Proposal {
  /** The rule's `ruleIdentity`. */
  r: string;
  rule: RuleRef;
  text: string;
  /** The repo keys holding it as a pin when it was proposed. */
  repos: string[];
  t: number;
  shown?: Showing;
  kept?: number;
}

/** Where and when a proposal was shown (its repo key and session `ep`), and that repo's next session. */
export interface Showing {
  t: number;
  repo: string;
  ep: string;
  next?: string;
}

type ProposalRecord =
  | { k: "propose"; r: string; rule: RuleRef; text: string; repos: string[]; t: number }
  | { k: "shown"; r: string; t: number; repo: string; ep: string }
  | { k: "next"; r: string; t: number; ep: string }
  | { k: "keep"; r: string; t: number };

/** Every proposal, folded from `proposals.jsonl`. */
export function readProposals(root: string): Proposal[] {
  let lines: string[] = [];
  try {
    lines = readFileSync(join(userGlobalDir(root), PROPOSALS_FILE), "utf8").split("\n");
  } catch {
    return [];
  }
  const proposals = new Map<string, Proposal>();
  for (const line of lines) {
    let record: ProposalRecord;
    try {
      record = JSON.parse(line) as ProposalRecord;
    } catch {
      continue;
    }
    if (typeof record?.r !== "string" || typeof record.t !== "number") continue;
    if (record.k === "propose" && typeof record.text === "string" && typeof record.rule?.k === "string") {
      if (!proposals.has(record.r)) proposals.set(record.r, { ...record, repos: [...(record.repos ?? [])] });
      continue;
    }
    const known = proposals.get(record.r);
    if (!known) continue;
    if (record.k === "shown" && typeof record.repo === "string" && typeof record.ep === "string")
      known.shown ??= { t: record.t, repo: record.repo, ep: record.ep };
    if (record.k === "next" && known.shown && typeof record.ep === "string") known.shown.next ??= record.ep;
    if (record.k === "keep") known.kept ??= record.t;
  }
  return [...proposals.values()];
}

/** A rule pinned in some repo: where, and its newest statement there. */
interface Pinned {
  repos: Set<string>;
  newest: { text: string; rule: RuleRef; at: number };
}

/** The rules pinned and in force in each repo store under the root, from its rule index and its validity. */
function pinsAcrossRepos(root: string, now: number): Map<string, Pinned> {
  const pins = new Map<string, Pinned>();
  let repos: string[] = [];
  try {
    repos = readdirSync(join(root, "repos"));
  } catch {
    return pins;
  }
  for (const repo of repos) {
    const dir = join(root, "repos", repo);
    const rows = readRuleIndex(dir).filter((row) => !(typeof row.validUntil === "number" && row.validUntil <= now));
    const invalid = rows.length ? readInvalidations(dir) : [];
    for (const row of rows) {
      const pinned = pinnedRules(row);
      if (!pinned.size) continue;
      const { text, rules: inForce } = rulesInForce(row, invalid);
      for (const rule of row.rules ?? []) {
        const identity = ruleIdentity(rule);
        if (!pinned.has(identity) || !inForce.has(identity)) continue;
        const known = pins.get(identity) ?? { repos: new Set<string>(), newest: { text, rule, at: -Infinity } };
        known.repos.add(repo);
        if ((row.at ?? 0) > known.newest.at) known.newest = { text, rule, at: row.at ?? 0 };
        pins.set(identity, known);
      }
    }
  }
  return pins;
}

/** Sleep's step (see the header): proposes each rule pinned in ≥ 2 repos and not kept or proposed before. */
export function proposeRecurring(root: string, now: number): Proposal[] {
  const proposed = new Set(readProposals(root).map((proposal) => proposal.r));
  const kept = new Set(readUserRules(root).flatMap((row) => (row.rules ?? []).map(ruleIdentity)));
  const fresh: Proposal[] = [];
  for (const [identity, { repos, newest }] of pinsAcrossRepos(root, now)) {
    if (repos.size < 2 || proposed.has(identity) || kept.has(identity)) continue;
    const rule = keptRef(newest.rule);
    fresh.push({ r: identity, rule, text: clauseOf(newest.text, rule), repos: [...repos].sort(), t: now });
  }
  if (fresh.length)
    appendLines(
      join(ensureDir(root), PROPOSALS_FILE),
      fresh.map(({ r, rule, text, repos, t }) => ({ k: "propose", r, rule, text, repos, t })),
    );
  return fresh;
}

/** The proposal a SessionStart shows: the first never shown whose rule this repo holds as a pin. */
export function proposalToShow(root: string, pinnedHere: ReadonlySet<string>): Proposal | undefined {
  return readProposals(root).find((proposal) => proposal.shown === undefined && pinnedHere.has(proposal.r));
}

/** Where a proposal was shown: the repo key and the session's `ep`. */
export interface AnswerPlace {
  repo: string;
  ep: string;
}

export function markProposalShown(root: string, proposal: Proposal, now: number, at: AnswerPlace): void {
  appendLines(join(ensureDir(root), PROPOSALS_FILE), [{ k: "shown", r: proposal.r, t: now, ...at }]);
}

/** A SessionStart of a repo: the next session of each proposal it showed in an earlier one, still unanswered. */
export function noteNextSession(root: string, now: number, at: AnswerPlace): void {
  const waiting = readProposals(root).filter(
    ({ shown, kept }) => shown && kept === undefined && !shown.next && shown.repo === at.repo && shown.ep !== at.ep,
  );
  if (waiting.length)
    appendLines(
      join(ensureDir(root), PROPOSALS_FILE),
      waiting.map(({ r }) => ({ k: "next", r, t: now, ep: at.ep })),
    );
}

/**
 * A proposal as SessionStart briefs it, in D11's words and nothing else (no source, no age), with its rule, so its
 * cid is the rule's user-global one.
 */
export function proposalNote(proposal: Proposal): ProvenanceNote {
  const text = `Proposed for all projects: ${proposal.text} (say "yes, everywhere" to keep)`;
  return { id: `proposal:${proposal.r}`, text, kind: "constraint", tags: [ALL_PROJECTS], rules: [proposal.rule] };
}

/**
 * A typed "yes, everywhere" (see the header): keeps each proposal it answers, shown in this repo, in this session or
 * the one before it, within 7 days, and returns their identities.
 */
export function keepShownProposals(root: string, typed: string, now: number, at: AnswerPlace): string[] {
  const answers = String(typed ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((sentence) => KEEP_EVERYWHERE.test(sentence.trim()));
  if (!answers) return [];
  const answered = ({ shown, kept }: Proposal) =>
    !!shown &&
    kept === undefined &&
    shown.repo === at.repo &&
    (shown.ep === at.ep || shown.next === at.ep) &&
    now - shown.t <= ANSWER_MS;
  const due = readProposals(root).filter(answered);
  if (!due.length) return [];
  keepForAllProjects(
    root,
    due.map(({ text, rule }) => ({ text, rule })),
    now,
  );
  appendLines(
    join(ensureDir(root), PROPOSALS_FILE),
    due.map(({ r }) => ({ k: "keep", r, t: now })),
  );
  return due.map((proposal) => proposal.r);
}
