/**
 * Placing injections in an OpenAI-style message list. Context goes in a system message right before the latest
 * user message, so it reads as background for this turn, and the stable prefix (system prompt, earlier turns)
 * stays byte-identical for the model provider's prompt cache.
 */
import type { Injection } from "@eden/protocol";

export interface ChatMessageLike {
  role: string;
  content: unknown;
}

export function withContext<M extends ChatMessageLike>(messages: M[], injections: Injection[]): M[] {
  if (injections.length === 0) return messages;
  const text = injections.map((i) => i.text).join("\n\n");
  let at = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      at = i;
      break;
    }
  }
  const context = { role: "system", content: text } as M;
  return [...messages.slice(0, at), context, ...messages.slice(at)];
}

/**
 * One integration choice for the action firewall (`EdenClient.check`): hold the call and give the agent the finding
 * as the tool's result, saying how to go ahead anyway. This wording is the integration's, not Eden's: Eden's finding
 * inside it is data in its envelope. A tenant may instead show the finding to the user, or run the call and inject the
 * finding; docs/research/econ-firewall.md compares them.
 */
export function heldResult(tool: string, finding: Injection): string {
  return (
    `Not executed: ${tool} was held because the user's context partner has context on it.\n${finding.text}\n` +
    `To execute it anyway, call ${tool} again with the same arguments.`
  );
}
