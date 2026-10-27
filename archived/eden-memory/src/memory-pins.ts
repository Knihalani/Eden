/**
 * D9's pins (A4 §5.2, §6, §7): which of a rule row's rules are pins, the sleep step that promotes a policy said in two
 * sessions, and the `policy_recur` event.
 *
 * - **A pin** is a policy, never an intent. It is one when its row pins itself (`never`/`always` said explicitly, or
 *   "remember that …": the row's `pin` tag, `index.ts`), or once sleep promoted it: its ref carries `p`.
 * - **Promotion** (A4 §7's `recurring_policy`, run at sleep, A4 §6): a policy said unqualified in ≥ 2 sessions (rows
 *   of distinct `ep`, or a row's `eps`: the sessions that typed its text again word for word, which the store keeps
 *   as one row), compared by `ruleIdentity` ("never squash" and "never force-push" are two rules), is a pin in every
 *   row that states it. Only a statement still in force counts: a row superseded, or whose clause a later
 *   revocation or opposition took, said nothing that recurs. Twice in one session is not a recurrence.
 * - **`policy_recur`** (A4 §7): a typed, unqualified policy of a prompt whose rule a row of an earlier session
 *   states, as a policy or an intent, pinned or not. It is logged in the Submit's wide event; promotion reads the rows
 *   themselves, so it needs no log.
 */
import type { MemoryRecord } from "./index";
import { ruleIdentity, ruleRefs, rulesIn, withoutRules, type RuleRef } from "./memory-policy";
import { rulesInForce, type Invalidation } from "./memory-validity";

type RuleRow = Pick<MemoryRecord, "id" | "text" | "at" | "tags" | "rules" | "ep" | "eps">;

/** Whether a row's rule is a pin (see the header). */
export function isPinnedRule(row: Pick<MemoryRecord, "tags">, rule: RuleRef): boolean {
  return rule.q === undefined && (rule.p === true || (row.tags ?? []).includes("pin"));
}

/** The rules of a row that are pins, by `ruleIdentity`. */
export function pinnedRules(row: Pick<MemoryRecord, "tags" | "rules">): Set<string> {
  return new Set((row.rules ?? []).filter((rule) => isPinnedRule(row, rule)).map(ruleIdentity));
}

/**
 * What SessionStart may brief of a rule row (A4 §5.2: pins only): its text without the clauses stating a rule that
 * is not a pin; "" when none is.
 */
export function pinnedText(row: Pick<MemoryRecord, "text" | "tags" | "rules">): string {
  const pinned = pinnedRules(row);
  if (!pinned.size) return "";
  return withoutRules(row.text, (rule) => !ruleRefs([rule]).some((ref) => pinned.has(ruleIdentity(ref)))).trim();
}

/**
 * The rows sleep promotes (see the header), each with its rules as they become: the recurring policies marked `p`.
 * `rows` are the store's live rows.
 */
export function promotions(rows: readonly RuleRow[], invalid: readonly Invalidation[]): Map<string, RuleRef[]> {
  const sessions = new Map<string, Set<string>>();
  const stating = new Map<string, RuleRow[]>();
  for (const row of rows) {
    if (!row.rules?.length || !row.ep) continue;
    const { rules: inForce } = rulesInForce(row, invalid);
    for (const rule of row.rules) {
      const identity = ruleIdentity(rule);
      if (rule.q !== undefined || !inForce.has(identity)) continue;
      const said = sessions.get(identity) ?? new Set<string>();
      for (const ep of [row.ep, ...(row.eps ?? [])]) said.add(ep);
      sessions.set(identity, said);
      stating.set(identity, [...(stating.get(identity) ?? []), row]);
    }
  }
  const promoted = new Map<string, RuleRef[]>();
  for (const [identity, eps] of sessions) {
    if (eps.size < 2) continue;
    for (const row of stating.get(identity)!) {
      const rules = promoted.get(row.id) ?? row.rules!;
      promoted.set(
        row.id,
        rules.map((rule) => (ruleIdentity(rule) === identity && rule.q === undefined ? { ...rule, p: true } : rule)),
      );
    }
  }
  for (const [id, rules] of promoted) {
    const row = rows.find((known) => known.id === id)!;
    if (rules.every((rule, at) => rule.p === row.rules![at]!.p)) promoted.delete(id);
  }
  return promoted;
}

/**
 * A4 §7's `policy_recur` for a prompt the user typed (see the header): the identities of its unqualified policies
 * that a live row of another session states. `session` is the prompt's own `ep`.
 */
export function policyRecurrences(rows: readonly RuleRow[], typed: string, session: string | undefined): string[] {
  const said = ruleRefs(rulesIn(typed).filter((rule) => rule.kind === "policy")).map(ruleIdentity);
  if (!said.length) return [];
  const earlier = new Set(
    rows.filter((row) => row.ep && row.ep !== session).flatMap((row) => (row.rules ?? []).map(ruleIdentity)),
  );
  return said.filter((identity) => earlier.has(identity));
}
