/**
 * A coarse label for what the agent is doing, so the source map can learn "calendar helps when scheduling" per
 * user. Keyword rules for now; the label set is small on purpose, since every label splits the learning data.
 * Replace with a learned classifier once there is labelled traffic (docs/ROADMAP.md).
 */
export type Situation = "scheduling" | "communication" | "research" | "task" | "purchase" | "travel" | "general";

const RULES: [Situation, RegExp][] = [
  [
    "scheduling",
    /\b(meet(ing)?s?|calendar|schedul\w*|tomorrow|today|tonight|next week|availability|free at|call at|reschedule|invite)\b/i,
  ],
  ["travel", /\b(flight|hotel|trip|travel|airport|itinerary|booking|check[- ]?in)\b/i],
  ["purchase", /\b(buy|order|purchase|price|invoice|refund|subscription|receipt)\b/i],
  [
    "communication",
    /\b(email|mail|reply|respond|message|text|slack|dm|follow[- ]?up|draft|write|note|thank|chase|ping|tell|intro(duce)?)\b/i,
  ],
  ["research", /\b(find|look up|research|what is|who is|compare|summari[sz]e|learn about)\b/i],
  ["task", /\b(todo|to-do|task|remind|deadline|due|project|ticket)\b/i],
];

export function classifySituation(text: string): Situation {
  for (const [label, re] of RULES) if (re.test(text)) return label;
  return "general";
}
