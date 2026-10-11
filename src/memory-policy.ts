/**
 * D9's policy and intent extraction (A4 §3.1, A7 §5). Interface only: P2.1 builds it.
 */

export type ActionClass =
  | "integrate"
  | "review"
  | "complete"
  | "commit"
  | "push-upstream"
  | "branch"
  | "history-rewrite"
  | "stash"
  | "deploy"
  | "delete"
  | "dependency"
  | "destructive-db"
  | "generated"
  | "billing"
  | "protected-path";
export type Polarity = "pos" | "neg";
export type Qualifier =
  "yet" | "for-now" | "until" | "before" | "after" | "this-time" | "in-this-pr" | "today" | "this-week";

export interface Rule {
  kind: "policy" | "intent";
  class: ActionClass;
  polarity: Polarity;
  object: string;
  qualifier?: Qualifier;
  explicit: boolean;
}

export interface RuleRef {
  k: string;
  q?: Qualifier;
}

export const INTENT_TTL_MS = 7 * 86_400_000;

export function ruleKey(rule: Pick<Rule, "class" | "polarity" | "object">): string {
  return `${rule.class}|${rule.polarity}|${rule.object}`;
}

export function rulesIn(_text: string): Rule[] {
  return [];
}

export function extractRules(_text: string): Rule[] {
  return [];
}
