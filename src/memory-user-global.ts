/**
 * D11's user-global scope (A4 §1 `<root>/_user/`): the rules the user keeps for every repo, and the proposals that
 * lead to them.
 *
 * - **What it holds.** `policies.jsonl`: one line per rule kept for all projects, in the rule index's shape
 *   (`memory-rule-index.ts`) and tagged `all-projects`, so the guard, the Submit trigger and SessionStart read it
 *   beside a repo's own index. Policies only: never an intent, never a fact (D11: "never inferred from facts"). A
 *   repo row stating only rules kept here gives way to them (`withUserGlobal`), so one rule has one cid, `_user/P:…`
 *   (A4 §4).
 * - **How a rule gets there** (D11): a typed policy with an explicit phrase ("in all my projects", or "everywhere"
 *   and "globally" set off by a comma: `saysAllProjects`); `eden memory remember --global`; or a confirmed proposal.
 *   Callers pass text as the store keeps it (`storableText`: secrets redacted).
 * - **Proposals** (`proposals.jsonl`, append-only `propose`, `shown` and `keep` records): at sleep, a rule pinned in
 *   ≥ 2 repos (D9, `memory-pins.ts`), still in force in each, and neither kept nor proposed before, is proposed once.
 *   A SessionStart of a repo holding the pin shows it, once, in place of the pin's bullet: `Proposed for all projects:
 *   … (say "yes, everywhere" to keep)`. A later typed "yes, everywhere", as a sentence of its own, keeps each proposal
 *   shown and not yet kept. A proposal shown and never kept is not shown again.
 * - **How a rule leaves:** a typed revocation or outright opposite (A4 §3.1, L8) in any repo, or "that rule is gone"
 *   after the guard asked about it, moves it to `history.jsonl`. Each repo also reads it through its own validity, as
 *   it reads its own rows.
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
const KEEP_EVERYWHERE = /^(?:(?:yes|yep|yeah|ok(?:ay)?|sure)\b[\s,!.]*)?(?:keep it\s+)?everywhere[\s.!]*$/i;

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

/** The rows a repo reads: the user-global ones first, then its own rows that state a rule not kept globally. */
export function withUserGlobal<T extends { rules?: readonly RuleRef[] }>(own: readonly T[], global: readonly T[]): T[] {
  const kept = new Set(global.flatMap((row) => (row.rules ?? []).map(ruleIdentity)));
  const covered = (row: T) => !!row.rules?.length && row.rules.every((rule) => kept.has(ruleIdentity(rule)));
  return [...global, ...own.filter((row) => !covered(row))];
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

/** The rules kept for all projects that a typed text overturns (A4 §3.1, L8), moved to history. */
export function overturnUserRules(root: string, typed: string, now: number): string[] {
  const overturned = String(typed ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
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
  shown?: number;
  kept?: number;
}

type ProposalRecord =
  | { k: "propose"; r: string; rule: RuleRef; text: string; repos: string[]; t: number }
  | { k: "shown" | "keep"; r: string; t: number };

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
    if (known && record.k === "shown") known.shown ??= record.t;
    if (known && record.k === "keep") known.kept ??= record.t;
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

export function markProposalShown(root: string, proposal: Proposal, now: number): void {
  appendLines(join(ensureDir(root), PROPOSALS_FILE), [{ k: "shown", r: proposal.r, t: now }]);
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
 * A typed "yes, everywhere" (see the header): keeps every proposal shown and not yet kept, and returns their
 * identities.
 */
export function keepShownProposals(root: string, typed: string, now: number): string[] {
  const answers = String(typed ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((sentence) => KEEP_EVERYWHERE.test(sentence.trim()));
  if (!answers) return [];
  const due = readProposals(root).filter((proposal) => proposal.shown !== undefined && proposal.kept === undefined);
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
