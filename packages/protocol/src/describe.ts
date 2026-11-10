/**
 * How Eden describes its `ask_context` tool to an agent: the MCP server gives it, the client SDK exports it for a
 * tenant that registers `ask` as a tool of its own, and the lab's A/Bs read it from here, so what is measured is what
 * ships.
 */

/** The standard description: ask for a fact about the user that the conversation lacks. */
export const ASK_CONTEXT_DESCRIPTION =
  "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, " +
  "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their " +
  "people, projects or history that is not in the conversation.";

/** `askMulti` (trial, D485): the most questions one `ask_context` call may carry. */
export const ASK_MULTI_MAX = 5;

/**
 * `askMulti` (trial, D485): the description when one call may carry several questions. It differs from the standard
 * one in how to ask ("one or more questions", "each", and the last sentence), never in when: wording that made the
 * agent ask less lost facts (D257, D335).
 */
export const ASK_CONTEXT_MULTI_DESCRIPTION =
  "Ask the user's context partner one or more questions. It searches the user's connected sources (mail, calendar, " +
  "documents, CRM and more) and answers each with citations. Use it when you need a fact about the user, their " +
  "people, projects or history that is not in the conversation. Put every question you have in one call.";

/**
 * The questions of an `ask_context` call under `askMulti`, as a model may send them: `questions` (a list, or one
 * string), else the single-question arguments (`question`, or `query` as some models name it). Blank ones are
 * dropped and the list is cut at `ASK_MULTI_MAX`.
 */
export function askQuestions(args: unknown): string[] {
  const x = (args ?? {}) as { questions?: unknown; question?: unknown; query?: unknown };
  const given = x.questions ?? x.question ?? x.query;
  const list = Array.isArray(given) ? given : given === undefined || given === null ? [] : [given];
  return list
    .map((q) => (typeof q === "string" ? q : String(q)).trim())
    .filter((q) => q.length > 0)
    .slice(0, ASK_MULTI_MAX);
}

/** How much of a question heads its answer: enough to tell the answers apart, on one line. */
const QUESTION_HEAD_CHARS = 200;

/**
 * Several answers as one tool result (`askMulti`): each under its question, in the order asked. One answer is
 * returned as it is, so a call with one question reads exactly as the single-question tool's.
 */
export function joinAnswers(parts: readonly { question: string; text: string }[]): string {
  if (parts.length === 1) return parts[0]!.text;
  return parts
    .map((p, i) => {
      const head = p.question.replace(/\s+/g, " ").trim().slice(0, QUESTION_HEAD_CHARS);
      return `Question ${i + 1}: ${head}\n${p.text}`;
    })
    .join("\n\n");
}
